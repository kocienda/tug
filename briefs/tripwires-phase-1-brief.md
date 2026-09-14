<!-- brief-skeleton v1 -->

# Tripwires phase 1: a trip settles by its verb, never by a clock

**Purpose:** Phase 1 of `briefs/tripwires-multi-phase-brief.md`. The tripwire engine has never finished a landing-fired trip. The reason is now known and is not the one the parent brief guessed: the diagnosis phase works, and it is the authoring phase that a twenty-minute watcher kills mid-work, after which the engine deletes the arc out from under the still-running session and refuses the session's own resolve. This brief removes every wall-clock ceiling on a live session, reads turn-end from the supervisor instead of the output stream, and closes the smaller holes the parent brief found in the same machinery.

---

## Purpose {#purpose}

The parent brief's Phase 1 asked to "prove one trip, then fix the watcher", resting on its [F01] [F02] [F05] [F06] [F07] and decisions [B02] [B06]. Its [F06] guessed the four ceiling failures were the watcher misreading turn-end. That guess was wrong in a useful way, and this brief replaces it with what the transcripts show.

The user's calls that govern this phase, from the parent: "I don't like the sound of anything doing what it does *forever*," and on the twenty-minute ceiling, "This sounds too long. I don't think tripwires are for long-running jobs, but I also don't really know what I (or others) are going to use this feature for. So, building in a notion of timeouts might be premature at this point. If we do a good job of showing tripwires in the card and UI, then users might be able to monitor and take control as they like."

---

## Evidence {#evidence}

**[F01] The diagnosis phase works.** For every trip that reached a session, the diagnosis session in the inspection tree ran three to five minutes, used Bash a dozen times, and called `tugtool tripwire resolve edits --awaiting … --author …`. The verb answered "tripwire edits resolved trip 14 as awaiting". Read from the transcripts under `~/.claude/projects/-Users-kocienda-Library-Application-Support-Tug-tripwire-trees-<sha>/` for trips 6, 8, and 14. **(verified)**

**[F02] The authoring phase is what the ceiling killed, four times, with the work nearly done.** Each `--author` ask cut a real arc (`tripwire-edits-9ce2adad`, `-385d8b00`, `-2f123ab5`, `-b7205597`) and spawned an authoring session in its worktree. Those sessions ran 21 to 22 minutes of real work, editing `tugedit-core` against the ask. At twenty minutes `watch_turn` in `tugrust/crates/tugcast/src/feeds/tripwire_session.rs:136` returned `completed = false`, `run_phase` in `tripwire.rs:1146` wrote `failed` through `settle_if_running` with "did not finish inside its twenty minutes", `close_headless_session` killed the session, and `keep_or_discard` at `tripwire.rs:1453` discarded the arc because the status was not `Awaiting`. The sessions' own later resolve calls then answered "tripwire edits has no running trip to resolve — its newest trip is failed". Trip 5's authoring session wrote the whole story in its headline: "tripwire-edits dash worktree was deleted mid-run; the tugedit resolve/Tree fix was not made". Read from the authoring transcripts under `~/.claude/projects/-Users-kocienda-Mounts-u-src-tug--tug-worktrees-tripwire-edits-*/` and the trip rows' `settled_at_ms` minus `at_ms`, which is 22 to 24 minutes on every ceiling row. **(verified)**

**[F03] The ceiling is layered three deep and every layer settles the same row.** `TRIPWIRE_RUN_TIMEOUT` (20 min) in the session runner returns a partial outcome; `SETTLE_CEILING` (30 min) in `run_phase` races the verb and settles `failed` through a compare-and-set; `ORPHANED_RUN_AGE` (90 min) in `drain_queue` fails any `running` row older than that from any instance. `PROBE_TIMEOUT` (15 min) bounds the probe command. `SETTLE_POLL` (2 s) is how `run_phase` watches for the verb, because the writer is a `tugtool` in another process. The doc comments on each say they are set relative to one another ("set past the session runner's own twenty minutes", "comfortably past the longest run this build can produce") and no test pins that ordering. **(verified — `tripwire.rs:66-125`, `tripwire_session.rs:30`)**

**[F04] The supervisor already knows when a session's turn is over, and the arc runner already reads it.** Each session entry carries `turn_active`, `turns_ended`, `prompt_turns_ended`, `open_jobs`, and `spawn_state`; `is_finished` at `agent_supervisor.rs:693` is `!turn_active && open_jobs.is_empty()`, and the arc runner's `session_snapshot` at `arc_runner.rs:1211` reads exactly those fields for any ledger entry, with a `Idle`-without-child reading as a death. Headless sessions sit in the same ledger. `watch_turn` ignores all of it and scrapes `CODE_OUTPUT` frames for a `turn_complete` type, keying on `tug_session_id`, with its own broadcast-lag handling. **(verified)**

**[F05] A tugcast restart fails every running trip of its own instance at boot.** `sweep_stale_running` at `tripwire_ledger.rs:1196` marks this instance's `running` rows `failed` with reason `instance restarted`. Two of the six failures are this. The sessions those trips ran were children of the restarted process and are gone, so the row is honest; what is lost is any arc the authoring session had committed to, because the sweep does not look. **(verified)**

**[F06] A `claimed` row left by a crash is never swept and poisons its commit.** `claim_trip` inserts `claimed`; every normal path transitions it at once; both sweeps filter `status = 'running'`. A crash between claim and transition leaves a row that blocks every later claim of the same `(tripwire, sha)` through the unique constraint. Carried from the parent's [F07]. **(verified — `tripwire_ledger.rs:745,1196,1221`)**

**[F07] A full landing channel drops the landing with no row and a debug-level log line.** `landed` at `tripwire.rs:221` is `try_send` on a 64-deep channel; failure is `debug!`. The doctrine that every refusal is a row is not kept on this path. Carried from the parent's [F02]. **(verified)**

**[F08] `plan` mode is read-only except for the plans directory.** Diagnosis runs under `DIAGNOSIS_PERMISSION_MODE = "plan"`. The trip 14 diagnosis session wrote `~/.claude/plans/brief-a-tugtool-file-sprightly-charm.md` through the Write tool and the harness accepted it. No repo file was touched. **(verified)**

**[F09] The engine's tests already carry a scripted session runner.** `FakeSessions` and `Wedged` implement `TripwireSessionRunner` in `tripwire.rs` tests at 2556 and 3028, and `the_running_engine_trips_on_a_landing_whose_lineage_carries_the_fact` drives a landing through a real ledger at a temp path. The settle path is testable without a `claude`. **(verified)**

**[F10] The inspection trees clean up; the arcs did not leave worktrees.** `tripwire-trees/` is empty, `git worktree list` shows only the checkout, and `tugtool arc list` is empty, so `discard_agent_arc` did its job on every failed run, which is exactly the problem: it did it under a live session. **(verified)**

---

## Decisions {#decisions}

**[B01] No wall-clock ceiling settles a trip whose session is alive.** `TRIPWIRE_RUN_TIMEOUT` and `SETTLE_CEILING` are deleted. A trip settles in exactly three ways: its session runs the resolve verb; its session finishes its turn with no open jobs and never ran the verb, which settles `failed` with the headline "ended its turn without running the resolution verb"; or its session dies, which settles `failed` naming the death. This is the parent's [B06] applied: the runs the ceiling killed were real work, and a user who can see a trip on the card and take it over needs no clock to protect them from it. The one bound that survives on a live session is the machine's, not the trip's: the supervisor's own spawn budget.

**[B02] Turn-end and liveness are read from the supervisor's session entry, not scraped from the output stream.** The session runner watches the same facts the arc runner's `session_snapshot` reads [F04]: `turn_active`, `open_jobs`, `spawn_state`, and the turn counters. `watch_turn`, its broadcast subscription, and its lag handling go. The idle reading is held for the arc runner's idle-settle window before it is spent, for the reason `arc-never-stops` [B01] gives: a turn that just ended may be about to be followed by a background job's completion or a wake. The transcript the engine hands the authoring phase as "closing prose" is read from the session's transcript file, not from a frame scrape.

**[B03] An arc that holds commits is never discarded by a failure.** `keep_or_discard` keeps the arc when the trip settles `awaiting`, as now, and also when it settles `failed` with commits on the arc branch, naming the arc in the headline so the user finds it in the Arcs card. Discard remains the answer for `quiet`, and for a failure with an arc that has nothing on it. The parent's rule that a quiet trip leaves the base checkout byte-identical is kept and pinned. The restart sweep [F05] follows the same rule: a restart that fails a trip does not discard its arc.

**[B04] The `claimed` state is swept like `running`.** Both sweeps consider `claimed` rows as well as `running` ones [F06]. A claim that never transitioned is a crash by definition, and clearing it is what lets the same commit be evaluated again.

**[B05] The landing channel never drops a landing.** It becomes unbounded [F07]. A landing is a few strings and arrives at human pace, so there is nothing to bound against, and the alternative is a refusal nobody can see. If a send still fails because there is no engine, the log line is `warn`, not `debug`.

**[B06] The two ceilings that remain are bounds on things that are not sessions, and a test says so.** `PROBE_TIMEOUT` stays: a probe is an arbitrary command run unattended and a blocked one must be killed. `ORPHANED_RUN_AGE` stays as the one way another instance's crash is cleared, but is no longer described relative to a session ceiling that does not exist. `SETTLE_POLL` stays because the verb is cross-process. A test pins that no constant in the engine settles a trip while its session is alive, so the ceiling cannot come back by a doc comment's argument.

**[B07] The proof is tests over the real ledger and real verbs, and the live landing is the user's follow-through.** A landing on `main` cannot be produced from an arc worktree, and the running tugcast is the installed build, not the arc's. So the gate is: a scripted session that resolves long after the old ceiling would have fired settles by its verb; a session that ends without the verb settles `failed` with the right headline; a session that dies with commits on its arc keeps the arc; a landing-fired trip runs end to end through the existing engine harness [F09]. After the arc lands and the app is rebuilt, the user resumes `edits` and lets the next real landing fire it, and the parent brief's "no `failed` row in a week" is read from the trip log then.

**[B08] Prose in the two files this phase touches is rewritten to describe what runs.** The module header of `tripwire_session.rs` still describes a verdict tier, a work tier, pooled workers, and an envelope; the ceiling docs in `tripwire.rs` argue from ceilings that will not exist. Those are rewritten in this phase because leaving them would have the code lie about the change it just made. The wider vocabulary purge is the parent's Phase 2 and is not started here.

---

## Open Questions {#open-questions}

- **Does a restarted tugcast reattach to a trip's session or fail it?** Today it fails it [F05], and with [B03] the arc survives. Reattaching would need the session to outlive the instance, which is the adoption brief's territory. Left as it is; if a week of use shows restarts are common enough to matter, that is a finding for Phase 3.

---

## Non-goals {#non-goals}

- **Folding the trip queue into the supervisor's spawn budget.** The parent's [B02] second half and its Phase 2. This phase deletes ceilings and reads the supervisor; it does not move the scheduler.
- **The vocabulary purge and the schema rename.** Phase 2.
- **A tool allowlist for the diagnosis session.** [F08] shows `plan` mode kept the repo untouched; whether the plans-directory write matters is a Phase 6 doctrine question, not a Phase 1 defect.
- **Any change to the card, the API, or the poll.** Phases 4 and 5.
- **A user-visible timeout knob.** Rejected by the parent's [B06]; this phase removes the ceilings rather than exposing them.

---

## Exit {#exit}

**An arc.** The pieces land in this order because each removes something the next one's test would otherwise have to work around: read turn-end from the supervisor and delete the run timeout; delete the settle ceiling and give the three settle paths their headlines; keep arcs that hold commits; sweep `claimed` and unbound the channel, pinning the remaining ceilings; rewrite the two files' prose. Four to five steps.
