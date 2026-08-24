# Join Endgame Workflow — Brief

**Date:** 2026-08-20 · **Status:** brief for plan-devise · **Grounds:** [D142], [D144], tuglaws/dash-work-doctrine.md

## The incident

A `dash-implement` run walked steps 6–8 of `dash/layout-imposer-polish.md` on the `imposer-polish` dash. Every step committed, every ledger row flipped to `done`, the join draft was written — and the run ended with a generic "here's what remains" report. No join offer ever appeared. The user had to come ask why.

The proximate cause: the run never executed phase 3 of the skill. `just app-debug` was not run, `tugutil dash mark imposer-polish built` was not run, the `/join` pointer was not printed. And because the mark was never made, the server-side join pilot — whose first line is `if stage != "built" { return None; }` (`tugcast/src/feeds/join_pilot.rs:78`) — never ran. No candidate was reconciled, no Tier 0 check happened, no `join.prompt` fact was written, no modal raised. The entire [D142] arc sat dark behind one unmade declaration.

## The architectural fault

**The join arc's trigger is an agent chore instead of a machine fact.** The machine already held every fact it needed: the ledger knew the selected steps were `done` (`dash step done` wrote them), the rounds were committed (`dash commit` wrote them), the worktree was clean (`dash show` reports `uncommitted_changes: false`). What it lacked was a *voluntary declaration* that skill prose asks an LLM to remember to type at the end of a run. Whether the user is offered their join hinged on agent diligence.

This is the [D144] sin in new clothes — an internal mechanism deciding a user-visible outcome — and it violates [D142]'s own charter: "the machine takes every step it can take unattended." The machine could have taken every step. It was waiting for permission from a markdown file.

The skill text made it worse: phase 2 ends with "stop walking and report the ledger state," and phase 3 (build → mark → draft → join pointer) reads as a separate act. An agent that stops at the end of a *selection* mid-plan plausibly reads "stop" as terminal and never enters phase 3. But even a perfect rewrite of the skill is the wrong fix — the experience must not be at the whim of the skill at all.

## The principle

**Nothing the user experiences may depend on a skill executing chores. Skills narrate; verbs record; the server derives.**

The verbs are deterministic and already run (an agent cannot walk a step without `dash step start`/`done`, cannot land a round without `dash commit` — the work itself forces them). The skill's phase-3 chores are the only part of the arc that runs on memory rather than necessity. Move every user-visible consequence off the chores and onto the verbs' records.

## The moves

### 1. The pilot keys off derived joinability, not the `built` mark

Kill the `stage == "built"` gate in `pilot_action` (`join_pilot.rs:78`) and in `standing_prompt` (`join_board.rs:309`). A dash is **joinable** when the machine can see it is:

- it has at least one round,
- no run holds it (occupancy — already checked),
- the worktree has no uncommitted changes,
- its rounds have quiesced (no round landed within a short settle window — the plan should pick the window and where it's measured).

Every input is already recorded deterministically. The pilot's other gates (blockers, standing question, stuck line, once-per-`(base_sha, dash_head)`) stay exactly as they are — this changes when the pilot *may* act, not what it does.

`mark built` survives as telemetry only ("a debug instance exists for this worktree"), gating nothing. `mark audited` likewise unaffected.

### 2. Selection completion is a first-class signal

`dash step done` on the final step of a run's selection is a machine-visible event the server can act on immediately — the natural "the work paused here on purpose" moment, sharper than quiescence alone. The plan should decide how the completion travels (the dash-log line the verb already writes is the obvious carrier) and make it a pilot dispatch moment alongside the existing changeset-recompute moment. Quiescence (move 1) remains the backstop for plan-less `dash-on` runs and hand-driven rounds, where no ledger exists.

### 3. The draft cannot be forgotten silently

`integrate_message`'s precedence (override → draft → branch description → "Dash work") already means a missing draft never blocks a join. But it fails *silently* — the join would land with the description and the user finds out afterward. The join prompt must show the message it will land with **and its provenance**: a prompt whose message is the draft shows the draft; one falling back to the description says so, visibly, so the user can bounce it and ask for a real draft. Writing the draft remains the agent's one genuine phase-3 obligation — it is prose, and prose is the agent's job — but forgetting it becomes visible instead of invisible.

### 4. The debug build decouples from the join

`just app-debug` is a vetting convenience. Whether a debug instance exists has nothing to do with whether the work is offerable, and welding them together in phase 3 is part of why the whole endgame got skipped. The skill still builds when the plan's work wants vetting; the join arc no longer waits on it.

### 5. The skills shrink to narration and prose

`dash-implement` and `dash-on` phase text is rewritten to match: walk the steps, write the draft, say what happened. The build-and-vet offer stays as narration. Every lifecycle consequence the skills currently "perform" — the mark, the arc arming, the join availability — happens server-side whether or not the skill says a word. A run that forgets everything still ends with the prompt raising on the bound session; agent diligence affects the *quality of the draft*, never *whether the user is offered the join*.

## What this deliberately does not change

- The one-decision UX: the prompt still offers Join now / Review first / Not yet, the re-ask policy still compares decisions ([P07]-style), the dismissal mark still lives on the branch config.
- The composer ⬆ as the one join door; `/join <name>` as the gesture.
- The candidate/strategy separation and the squash guarantee ([D144]).
- Occupancy, blockers, question/stuck yields — every existing pilot restraint.
- `dash step` / `dash commit` mechanics and the ledger format.

## Surfaces the plan will touch

- `tugrust/crates/tugcast/src/feeds/join_pilot.rs` — the predicate (`pilot_action`), its tests.
- `tugrust/crates/tugcast/src/feeds/join_board.rs` — `standing_prompt`'s gate; the prompt payload grows the landing message + provenance.
- `tugrust/crates/tugcast/src/feeds/changeset.rs` / `agent_supervisor.rs` — pilot dispatch moments (add step-completion; keep recompute).
- `tugrust/crates/tugdash-core` — joinability derivation (rounds, uncommitted, quiescence), step-completion fact if it needs a home beyond the dash-log.
- `tugdeck` prompt sheet (`session-changes` join prompt surface) — render the landing message and its provenance.
- `tugplug/skills/dash-implement/SKILL.md`, `dash-on/SKILL.md` — phase text rewrite (repo copy; note the bundle-copy caveat for live testing).
- `tuglaws/design-decisions.md` — the decision recording this; amends [D142].
- App-tests: the at0445 prompt arc gains the no-mark path (a dash that was never marked `built` still prompts); a pin that a missing draft shows its provenance in the prompt.

## Open questions for the plan

- **[Q] Quiescence window**: how long after the last round before the pilot may act, and measured where (round timestamp vs. dash-log)? Small — seconds, not minutes — since step-completion (move 2) carries the sharp signal when a ledger exists.
- **[Q] `dash-on` parity**: plan-less dashes have no ledger; is quiescence + clean worktree sufficient there, or should `dash-on`'s wrap-up verb (if any) emit the completion signal?
- **[Q] Prompt refresh**: when a draft is written *after* the prompt was raised (agent finishing late), does the standing prompt re-derive its shown message on the next recompute (it should — it is already re-derived durable state), and does that need a pin?

## Live recovery note

The `imposer-polish` dash is sitting joinable-but-dark right now (7 rounds, clean worktree, draft written, never marked). It is both the incident and the first live test: once move 1 lands, this dash should prompt with no further gesture. Until then, `tugutil dash mark imposer-polish built` is the manual unblock if the user wants the join before the fix ships.
