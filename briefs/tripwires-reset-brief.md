<!-- brief-skeleton v1 -->

# Tripwires reset: a fact is the trigger, a trip never stands in a live checkout, and every trip is visible

**Purpose:** Tripwires were meant to be a general facility: lay a condition about sessions, and when a fact of that kind is recorded, an AI session spawns automatically to do interesting work in response. What was built fires only when a commit lands, hides its ordinary outcome, and cannot show a trip while it runs. The first vetting session proved the machinery underneath works and the model on top of it does not. This brief resets the model and supersedes `briefs/tripwires-multi-phase-brief.md`.

---

## Purpose {#purpose}

> "My goal for tripwires is to make it a *general facility* to lay conditions about sessions, and have the AI spawn automatically to do interesting work in response when certain kinds of facts happen. I have no specific cases that I'm optimizing for. The goal is *generality*."

> "What is all this talk about 'landing'? I'm just asking about shell commands."

> "We are trying to do *the most trivial thing possible*, and your explanations are already thick with word-salad-y explanations. WTF is wrong with this infrastructure?"

The vetting went like this. With an empty roster, a tripwire named `commands` was laid on `fact:shell` with a passing probe, and a tripwire named `failed-commands` on `fact:shell --where ok=false` with no probe. A shell command was run in a Session card on a test repo and a commit landed. Both tripwires fired and settled correctly, the second by spawning a real diagnosis session that resolved quiet in 23 seconds. To the user, both times, nothing happened. Explaining why required the words landing, lineage, mark, claim, and swallow, none of which the user had asked about, because the trigger is not the thing the tripwire is named for.

The reset keeps what worked and removes the indirection. Three constraints are imposed and not negotiable:

- **The trigger is a fact being recorded.** The commit-time-only rule is removed.
- **A trip never stands in a live checkout.** It stands in a disposable worktree at `HEAD` and is handed a diff of the uncommitted state.
- **Every trip is visible, and its session is reachable from the moment it exists.**

---

## Evidence {#evidence}

**[F01] The commit-only trigger was a fix for the wrong variable.** `briefs/tripwire-simplification-brief.md` line 40 gives the reason the first fact-time design was abandoned: "the racing design corrupted the very checkout it was meant to help," the `tugedit-doctor` incident. The disaster was *where* the session stood, in the user's live checkout, not *when* it fired. A commit was adopted as the trigger because it supplies a sha to cut a disposable worktree from. Every indirection the current model carries traces to that substitution. **(verified — read out of the prior brief)**

**[F02] The bottom layer works, first time, in seconds.** With `failed-commands` armed and no probe, a `/commit` from the test repo produced: the landing at 18:20:28, a headless session spawned through `AgentSupervisor` in an inspection worktree under `plan` mode, two shell commands by that session reading the originating session's transcript, `tugtool tripwire resolve failed-commands --quiet` at 18:20:51, and the worktree swept at 18:20:53. Twenty-three seconds, no ceiling, no failure. The supervisor spawn, the Wheel rotation, the disposable worktree, the resolve verb, and the cleanup are sound. **(verified — `tugcast.log.2026-09-14`, `tugtool tripwire log failed-commands`)**

**[F03] Every fact passes through one funnel.** `SessionLedger::record_fact` in `tugrust/crates/tugcast/src/session_ledger.rs` is the single write path for every fact kind, with 32 call sites in `tugcast` feeding it. A fact-time trigger has one place to hook and no scavenger hunt. **(verified — grep)**

**[F04] The fact vocabulary is twelve kinds, built for a timeline rather than for triggering.** `tugcore::facts::FactKind` records `prompt`, `shell`, `test_run`, `edit_failed`, `commit`, six session-lifecycle kinds, and `session.compacted`. It was written to feed the Operator's timeline. Nothing records a tool call, a file edit, a turn end, an error the model hit, context pressure, or a prompt's subject. The lay verb now refuses a kind not on this list, so the list is the whole of what a tripwire can watch. **(verified — `tugcore/src/facts.rs`, landed as `8dab8eaab`)**

**[F05] The card cannot show a running trip.** The row's dot and its Open session verb both read `running_session`, which the API derives from the trip row's `session_id`. `start_run` in `tugrust/crates/tugcast/src/feeds/tripwire.rs` writes that column `NULL`, and the engine writes the real id only after the diagnosis phase returns, at line 1269. During every run the card has nothing to key on. **(verified — `tripwire.rs:1115`, `tripwire.rs:1266-1269`, `tripwires_api.rs:506`, `tripwires-card.tsx:427`)**

**[F06] When the session settles itself, its id is lost for good.** `run_phase` polls the trip row every two seconds. When the session's resolve verb flips the row to `settled`, the poll wins before the runner future returns, the outcome carrying the session id is never read, and the write at line 1269 is skipped. The trip that ran in [F02] reads `session_id: null` in `tugtool tripwire log --json`. There is no way to open the transcript of a diagnosis that decided quiet. **(verified — `tripwire.rs:1393-1412`, the JSON log row)**

**[F07] Quiet is invisible by design.** The skill and the engine both say it: a quiet resolution posts nothing anywhere except the trip log, and the log sits behind a fold on the card. The two vetting trips left no trace a person looks at. A user shaking down a first tripwire will conclude it is broken, which is exactly what happened. **(verified — `tugplug/skills/tripwire/SKILL.md`, both vetting runs)**

**[F08] The vocabulary is the indirection made visible.** Claim on `(tripwire, sha)`, per-`(tripwire, session)` high-water marks, lineage resolution, the landing event, and the swallow reasons `busy`, `no-match`, `own-arc`, `out-of-scope` all exist to make a commit-time lookback correct. None would exist if the trigger were the fact itself. **(verified — `tripwire.rs` `consider`, `tripwire_ledger.rs` `tripwire_marks`, `claim_trip`)**

**[F09] `plan` mode stops writes, not interpreters.** The diagnosis session in [F02] ran `python3 -c` to read a transcript under `plan` mode without objection. Read-only is enforced for the tree by the disposable worktree, not by the mode. **(verified — `tugcast.log.2026-09-14`, fact row 736879)**

**[F10] The scope was stored in a spelling no event carries.** `canonical_scope` used bare `std::fs::canonicalize`, against [L29], so a scope passed as `$PWD` was stored as `/System/Volumes/Data/…` while every landing arrives in the Claude form. Fixed in `8dab8eaab`; recorded here because a fact-time trigger compares the same field and inherits the fix. **(verified)**

---

## Decisions {#decisions}

**[B01] The trigger is a fact being recorded, and nothing else.** A tripwire's condition is evaluated when `record_fact` writes a fact of the kind it names [F03]. A commit is one more fact kind: today's behavior becomes `--on fact:commit`, a special case of the general rule rather than the whole design. This is the user's call and the whole point of the reset [F01]. It rules out the landing event, the claim-by-sha, the per-session marks, lineage resolution, and the swallow taxonomy [F08]. What replaces them is: a fact arrives, does it match, is the tripwire free, spawn. Revisited only if a fact kind turns out to need a lookback that a single fact cannot express, and that is a new fact kind, not a new trigger.

**[B02] A trip never stands in a live checkout.** This is the guard that actually prevents the `tugedit-doctor` disaster [F01], and it is independent of the trigger. Every trip session runs in a disposable worktree cut at the repository's `HEAD` when the fact arrived. It is handed, in its prompt, the fact, the originating session's transcript, and a diff of the uncommitted working tree at that moment, so it sees the state the fact happened in without being able to touch it. The worktree is removed when the trip ends, as today. Nothing a trip does can reach a tree a user is in.

**[B03] Three guards survive, and only three.** One live trip per tripwire: a tripwire with a trip running or awaiting is not evaluated. A tripwire never fires on facts recorded by a session it spawned, matched by session id, exactly. Scope and `--where` narrow which facts it sees. These are what made the first version survivable and they do not depend on commits. Cooldowns, high-water marks, and supersede do not survive; a second matching fact while a trip runs is a skipped evaluation, written to the log as such.

**[B04] Every trip is visible, and its session is reachable from the moment it exists.** The trip row learns its session id when the supervisor seats the session, not when the phase returns [F05] [F06]. The card shows a running trip with its dot and Open session from that instant. A quiet resolution is a visible row on the card with the session still openable, not a log entry behind a fold [F07]. The collapsed band counts trips, including quiet ones, so a tripwire that has fired can be told from one that has not without opening anything.

**[B05] The fact vocabulary is the API, and growing it is its own workstream.** Generality lives in what can be watched [F04]. A trigger source that can only see twelve timeline kinds is not general. The recorder grows kinds for what sessions actually do: tool calls, file edits, test results, turn ends, errors the model hit, context pressure, prompts with content. Each kind is added to `tugcore::facts::FactKind` first so the recorder and the lay verb learn it together. This is independent of [B01] through [B04] and can proceed in parallel; it is what makes tripwires interesting rather than merely correct.

**[B06] The work a trip does is whatever the brief says, and the endings are the three verbs.** Nothing about "diagnosis" is hardwired. A trip runs the tripwire's brief in a session and ends by resolving quiet, resolving awaiting with a headline and optionally an author ask, or being adopted by a card. Authoring, when asked for, still creates a real arc that the user joins or discards, and a tripwire never joins. The probe survives as the free path: a command that exits 0 settles the trip with no session.

**[B07] The vocabulary is tripwire, lay, trip, fire, resolve, adopt, and the log.** Landing, lineage, mark, claim, swallow, supersede, and dossier leave the code, the schema, the skill, and the card, with a migration and a guard against their return. A trip is skipped, running, quiet, awaiting, adopted, or failed, and those six words are the row's whole state.

**[B08] What is kept is named so it is not rebuilt.** The supervisor's headless spawn and its budget, the Wheel rotation with the `tripwire` stage label, the disposable worktree and its refcounted removal, the resolve and dismiss verbs, the `tugtool tripwire` CLI surface, the ledger's open-through-`ledger_db` discipline, the card's bones and the arcs-card conventions it has adopted, and the `/tripwire` skill's flow. The reset is of the trigger and the trip's shape, not of the plumbing [F02].

**[B09] This brief supersedes the multi-phase brief and its unfinished phases.** `briefs/tripwires-multi-phase-brief.md` and the phase briefs under it read the feature as a post-commit inspector. Phases that landed are kept as code; phases not yet walked are not walked. The card work in phase 5, the skill and doctrine work in phase 6, and the hardening in phase 7 are re-derived from this document.

---

## Open Questions {#open-questions}

- **What does a trip see of a session still mid-turn?** [B02] hands the trip a transcript and a diff at the moment the fact arrived. The originating session may still be working. Whether the trip is told "this session is still running" and given a way to wait or re-read, or is handed a snapshot and nothing more, is settled by the first fact kind that needs the answer. The snapshot is the default until then.

- **Which facts fire synchronously and which are batched?** A `shell` fact arrives on every Bash call. A tripwire on `fact:shell` with no `--where` fires on the first and skips the rest while the trip runs [B03], which is correct but noisy in the log. Whether the engine should evaluate on every write or drain a short queue is a measurement question for the first week of real use, not a design question here.

- **Does a trip session get a tool allowlist?** `plan` mode does not stop an interpreter [F09]. The disposable worktree makes that harmless to the tree, but a trip that runs `curl` or `tugtool tell` is not harmless to everything. Settled by reading what the first general-purpose tripwires actually want to run.

- **What releases an awaiting trip?** Carried over unchanged. The card's Release act and the arc's fate are the two releases today; nothing on a clock. Whether a later fact of the same kind supersedes the question is decided when it comes up.

---

## Non-goals {#non-goals}

- **Firing on git commits made outside Tug.** A commit made by a hand-typed `git commit` records no fact, so no tripwire sees it. Out, as every prior brief decided; a git watcher is a different feature.
- **A trip that runs in the user's checkout, ever.** Rejected by [B02] and by the incident that started this. No flag, no mode, no "it's read-only anyway."
- **Keeping the commit-time lookback as an option.** Rejected by [B01]. Two trigger models would double the vocabulary this reset exists to halve.
- **Running trips on the arc runner or showing them in the Arcs card.** Unchanged from the prior brief. A trip has no plan and no steps; only the arc it may author is an arc.
- **A lay form on the card.** Authoring stays in the `/tripwire` skill.
- **User-facing timeouts.** Engineering guards against a runaway session stay guards; none becomes a knob.
- **Cooldowns, high-water marks, supersede.** Removed by [B03]. The one-live-trip rule and the own-session guard are the whole anti-loop defense.

---

## Exit {#exit}

**An arc, on this brief.** The shape, in the order it has to land:

1. **Session id at spawn.** The runner writes `record_run` the moment the supervisor seats the session [B04]. This is ten lines, it fixes [F05] and [F06], and it is worth landing before anything else so the card can show every trip that follows.
2. **The fact-time trigger.** Hook the engine on `record_fact` [B01]; evaluate scope, `--where`, the one-live-trip rule, and the own-session guard [B03]; remove the landing path, the claim, the marks, and the swallow reasons [B07], with a schema migration.
3. **HEAD plus diff.** Cut the worktree at `HEAD` on fire; put the fact, the transcript, and the uncommitted diff in the prompt [B02].
4. **Visibility.** Quiet rows on the card, the band's counts, Open session on every row that had a session [B04].
5. **Skill and words.** Rewrite `tugplug/skills/tripwire/SKILL.md` against the new model, purge the retired words, add the guard.
6. **Vocabulary growth** [B05], as its own arc alongside, starting from whichever fact kinds the first general-purpose tripwires ask for.

Step 1 lands alone. Steps 2 and 3 land together, because a fact-time trigger with no worktree is the incident again. The vetting that started this session is the acceptance test: lay a tripwire on `fact:shell --where ok=false`, run a failing command in a Session card, and watch the row appear with a dot, a session to open, and a quiet resolution the user can read.
