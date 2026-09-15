# Tripwires: one visible session with hands

**Purpose:** A trip today throws its answer away, spawns a second session nobody asked for, and runs without a bound or a window into it. Make a trip one ordinary session with hands, on the tripwire's own arc, that always reports and can always be watched.

---

## Purpose {#purpose}

The first tripwire laid after the `tripwires-reset` join was the simplest one there is: `failing-commands`, on `fact:shell --where ok=false`, with a brief asking for one or two sentences on why the command failed. The run produced, in the user's words:

> Do *nothing* and report *nothing*. Like in this case, where it's supposed to report results on failures, and instead does *nothing*.
>
> Run interminably for no reason I can fathom. Like `@wintry-table`. WTF is that session doing? I have no way to understand or introspect it. WHY IN HEAVEN would it take ten minutes to diagnose a failed command?
>
> Go off on their own and do *WHO THE F\*CK KNOWS WHAT* without any sense of control.

And the standing position: *"I want Tripwires, but we're struggling to make them work."* The question is not whether a trip should have hands. A tripwire that can only talk is a linter with a large bill, and hands are the point. The question is who grants them, in what room, for how long, and where the answer goes.

---

## Evidence {#evidence}

**[F01] The trip answered its brief and the answer was discarded.** Trip 1 fired on `$ false`, opened a headless session in the disposable tree, and six seconds later ran `tugtool tripwire resolve failing-commands --quiet`. The row reads `quiet` with no headline. The sentence the brief asked for was written in that session's transcript and nothing captured it: the engine's contract (`tripwire.rs:1512` onward) offers the model two exits, `--quiet` meaning "nothing here is worth the user's attention" and `--awaiting --headline`, and a trip that has answered a diagnostic question has no exit that carries the answer. **(verified, from the instance session ledger's `facts` rows for session `05d9a235`)**

**[F02] `@wintry-table` is a second session the model decided to open.** Trip 2's diagnosing session resolved `--quiet --author "In the failing-commands tripwire's detector, skip Bash facts with a null exit_code…"`. The `--author` flag made the engine cut an arc `tripwire-failing-commands-54833e72` with a worktree under `.tug/worktrees/` and spawn an authoring session on it with the `authoring_contract` prompt (`tripwire.rs:1544`). That session spent its turn grepping `tripwire_predicate.rs`, `tuglaws/tripwires.md`, and `SKILL.md` for `--where` semantics, committed nothing, and never resolved. The trip row reads `running` with an `arc` attached and a `settled_at_ms` already set, a state the six statuses do not name. **(verified, ledger rows for sessions `b87dfeae` and `fc05762b`, and `tugtool arc list`)**

**[F03] The brief lost to the appended contract.** The brief said "Do not fix anything." The engine appended a paragraph inviting `--author` on either exit, unconditionally. The model followed the appended text. The brief is the only thing the user wrote, and nothing in the prompt composition gives it precedence. **(verified, prompt payload of the trip's `prompt` fact)**

**[F04] Nothing bounds a trip.** The only timeouts in the engine are `PROBE_TIMEOUT` (15 minutes, for the probe command), `ORPHANED_RUN_AGE` (90 minutes, for noticing a run whose process is gone), and the sweep and settle ticks. There is no wall-clock cap, turn cap, or tool-call cap on the model session itself. **(verified, `tripwire.rs:71-109`)**

**[F05] The trip fired on a command that never ran.** Trip 2's fact was a `sleep 45; …` call that Claude Code's PreToolUse gate refused. The hook recorded it as `kind=shell`, `ok=false`, `exit_code=null`. `ok` is derived from the tool result's error flag (`facts_library.rs:1001`, `ok: !is_error`), so a denial and a non-zero exit are indistinguishable to a `--where ok=false` matcher. **(verified)**

**[F06] The trip's session is reachable only after the fact, and only by its dot.** The Tripwires card row opens `open_session` on click (`tripwires-card.tsx:431-469`). While the trip runs, nothing on screen shows what its session is doing, and the authoring session's tool calls in [F02] were recoverable only by querying the ledger with `just db-inspect`. That the session runs without a card of its own is inference from the user's report and the spawn path; what would confirm it is reading the spawn request the engine hands the supervisor.

**[F07] A skip was correctly written for a foreign fact.** Trip 3 was a failing `cargo fmt --check` in the user's `hidden-arrival` arc session, skipped `busy` because trip 2 held the live slot. The guard held. It is the one part of the run that behaved as the user would expect. **(verified)**

---

## Decisions {#decisions}

**[B01] A trip is one session, and it has hands from its first turn.** There is no diagnosis stage, no `--author`, and no second spawn. The two-session shape exists to let the model decide whether a change is worth making, and [F02] and [F03] are what that decision costs: the model's judgment overrode the user's brief and produced an unbounded session with no report. Whether a trip acts is answered by the brief, because the brief is the prompt. A brief that says "diagnose only" gets a session that diagnoses; a brief that says "fix the lint" gets one that fixes it. The engine appends the fact, the tree, and the closing rule from [B04], and no menu of exits.

**[B02] Every tripwire owns one arc, and its trips work there.** The arc and its worktree are created when the tripwire is laid and replayed onto the base's HEAD before each trip. A trip that changes something commits a round with `tugtool arc commit`, exactly as any arc does. The user joins or discards through the Changes shade they already use, so nothing reaches `main` without their gesture. This retires the disposable tree at HEAD, the `.diff` sidecar, the `InspectionTrees` refcount, and the per-trip arc naming of [F02]. One arc per tripwire rather than per trip means the rounds accumulate on one branch with one join, and a tripwire's whole history of changes is one `git log`.

**[B03] A trip is a Session card.** The trip's session appears in the deck like any other, tagged with the tripwire's name, so its tool calls can be watched live, its transcript read, and the session stopped. The Tripwires card row opens it while it runs, not only after. This is what answers "I have no way to understand or introspect it": the session already exists in the ledger, and the deck is where sessions are seen.

**[B04] A trip always reports, and the report is its final message.** When the session ends, its last assistant message is captured as the trip's report and shown on the row. `--quiet` and `--awaiting` are no longer verbs the model must call, and `resolve` is no longer how a trip ends. The one closing rule appended to the prompt is to end with a short report. This makes [F01] impossible: a trip that answers its brief has put the answer where it is read.

**[B05] A trip is bounded by wall clock and by tool calls.** Both caps are set on the tripwire at `lay` time, with defaults on the order of two minutes and thirty tool calls. A trip over either cap is stopped and recorded `failed`, transcript kept. The cost of laying a tripwire becomes knowable before it is laid, which is the answer to "run interminably" in [F02] and [F04].

**[B06] Four statuses: `skipped`, `running`, `done`, `failed`.** `done` carries the report and the count of rounds the trip committed. `quiet` and `awaiting` are retired: whether a trip deserves attention is read from the report and from whether a round exists, not from a word the model chose. `adopted` is retired with the second session it named. The Tripwires card and the feed's headline vocabulary follow.

**[B07] A gate-denied command is not a failed command.** A shell fact whose exit code is absent because the command never ran must not satisfy `ok=false`. Either such a call is not a `shell` fact at all, or `ok` gains a third value the matcher can name. The first is preferred: a command the gate refused is a fact about the gate, not the shell.

**[B08] The brief is the prompt, and the engine's additions are inert.** What the engine appends states facts and location: the fact that fired, the tree the session stands in, the arc to commit on, the closing rule from [B04]. It offers no choices and issues no instructions the brief did not. A future addition to the appended text that tells the model what to decide is the defect in [F03] returning.

---

## Open Questions {#open-questions}

- **Where a trip's card lands in the deck.** A trip that fires while the user is working should not steal focus or split their column. Whether it opens minimized, in a lane of its own, or only as a row that becomes a card on click is a layout call to be made against the deck's arrival rules, not settled here.
- **Default caps.** Two minutes and thirty tool calls are a starting guess. The right numbers come from a week of laying real tripwires under [B05] and reading which ones hit the cap.

---

## Non-goals {#non-goals}

- **A read-only trip.** Considered as the safe default and rejected: hands are the point, and control comes from the arc and the caps, not from withholding hands. A brief that wants only a diagnosis says so.
- **Keeping the two-stage shape with better prompts.** The failure in [F03] is structural: any menu of exits the engine appends competes with the brief. Rewording the menu does not change who wins.
- **A notification or attention system.** Whether the report is worth reading is the user's judgment from the report. No headline vocabulary, no `awaiting` hold, no unread state beyond what the deck already gives a session.
- **Deleting tripwires.** On the table in the conversation and set aside: the engine's fact-time trigger, scope, `--where`, the skip guards, and the ledger are sound, and [F07] shows them working. What is wrong is the room the trip runs in and what happens to its answer.

---

## Exit {#exit}

**An arc.** The shape of the first steps, in the order they must land:

1. Retire the second session: remove `--author`, `author_ask`, the `authoring_contract`, the per-trip arc creation, and the `adopted` status, with the ledger migration that carries it.
2. Give every tripwire an arc at `lay` time and replay it onto HEAD before each trip; retire the disposable trees, the `.diff` sidecar, and their sweep.
3. Capture the session's final message as the trip's report; collapse the statuses to four; remove `resolve` as the way a trip ends and the contract paragraphs that name it.
4. Add the wall-clock and tool-call caps to the tripwire and the run phase.
5. Spawn the trip as a Session card and make the row open it while running.
6. Stop gate-denied commands from recording as failed shell facts.
7. Bring the Tripwires card, `tugtool tripwire log`, the feed headlines, `SKILL.md`, and `tuglaws/tripwires.md` to the new vocabulary, and rerun the `failing-commands` recipe as the acceptance check: `$ false` opens a visible card, produces one sentence on the row, commits nothing, and closes inside the cap; a gate-denied call does not fire.
