# Tripwires

A **tripwire** is a standing condition on what sessions do: it sits on the machine doing nothing until a session records a **fact** of the kind it names, then fires a **trip** — one bounded session, with hands, standing on the tripwire's own arc — that runs a probe, asks the brief about what the probe could not settle, and ends with a report of what it found.

This document is the feature's durable doctrine — the lifecycle, the guards, the caps, and the rules that are arguments rather than implementation details. The door where a tripwire is written and its judgement are the `/tripwire` skill's, which ships in the bundle and stands alone; the trip engine is `tugcast::feeds::tripwire`, the ledger is `tugtool_core::tripwire_ledger`, the projection every surface reads is `tugtool_core::tripwire_roster`, the roster feed is `tugcast::feeds::tripwires`, the request surface is `tugcast::tripwires_api`, and the surface is `tugdeck/src/components/tripwires/`.

## Only a recorded fact fires one

Work done outside a Tug session is invisible to the whole facility — a `git commit` typed in a terminal records no fact and fires nothing. That is the design rather than a gap: the session ledger is the one place that knows what happened, which session it happened in, and which checkout that session was working in, so it is the one place a firing can be built from without guessing.

**The trigger is the fact being recorded, and nothing else.** A tripwire named for a shell command that failed fires when that command fails, at the moment the ledger writes it — not later, when something is committed, and not against a window of facts looked back over. The engine sees each fact exactly once, on the process-global channel `session_ledger::record_fact_tx` writes to after its insert commits, which is why there is no ceiling to keep and no lookback to get wrong. A condition about a commit is a condition on the `commit` fact, whose payload carries the branch it went onto.

**A command the gate refused is not a command that failed.** Claude Code wraps the result of a tool call that never ran in `<tool_use_error>`, and a command that ran and exited non-zero opens `Exit code N` bare; the recorders read that prefix and write no `shell` fact at all for the former. A refusal is a fact about the gate rather than about the shell, so `fact:shell --where ok=false` keeps its plain meaning and stops firing on calls nobody made. The spelling is a Claude Code output convention rather than a published contract, which is why it is one named function with one test naming both shapes.

## A trip is a session **on** the tripwire's arc

An arc is a walk over a ledger with stages and document-shaped facts. A trip has no plan and no steps, so it is not put on the arc runner and never appears in the Arcs card. But it *stands* on an arc, and that is the whole of where it runs: **every tripwire owns one permanent arc**, `tripwire-<name>`, made in a recorded home checkout when the tripwire is laid and kept for as long as the tripwire stands. Trips are shown in the Tripwires card and nowhere else.

**The arc is permanent and the trip is not.** Before each trip the engine replays the arc onto its checkout's `HEAD`, so a trip starts from the base as it is now and from whatever earlier trips of the same tripwire left behind. A per-trip arc was the alternative and it is worse twice over: it made a tripwire's work a scatter of branches nobody could find, and it made the engine's sweep — which discards an arc with nothing on it — a hazard aimed at the one thing that must survive.

**A trip's rounds are a difference, not a count.** The arc carries every earlier trip's commits, so what this trip committed is the round count after minus the round count before. A trip that committed nothing reads zero, which is the ordinary case for a brief that asked a question.

## The lifecycle, over four statuses

A trip's row is written once, by the decision that made it, and then transitions in place. Every guard runs *before* the row exists, so a refusal is a row minted `skipped` with its reason on it rather than a claim taken back — one event is one row per tripwire, which the ledger's `UNIQUE(tripwire_id, event_key)` constraint promises and the `INSERT OR IGNORE` behind every write keeps true however many instances race.

- **`skipped`** — it did not run, and the row's reason says which: `busy` (this tripwire already has a live trip), `ceiling` (the machine is at its trip limit), `no-room` (the host had no room for a session). **There is no queue.** A tripwire asked to verdict five events in a storm wants the last one's verdict rather than five worktrees, and the honest way to say that is a visible row saying the trip did not run — a queue that coalesced to the newest was the same answer wearing a mechanism, and it cost two statuses to express.
- **`running`** — a probe or a session is working it now. Its session id is on the row from the moment the supervisor seats the session rather than when the phase returns, so a trip that is working is a trip the card can open.
- **`done`** — it finished. What it found is its **report** and whether it committed is its **rounds** count.
- **`failed`** — it did not finish: a session that died, a run the engine could not start, or one that met a cap. A host at its spawn budget is not this — that is a `skipped` row reading `no-room`, because busy is not broken.

**There is no second finished status, and that is the decision.** `quiet`, `awaiting` and `adopted` each named a finished trip, and each asked the model to describe its own findings with a word: *is what I found worth the user's attention?* That is a judgement the brief should be making, and a menu of exits offered at the end of a turn is a menu that beats the brief. So a trip that found nothing and a trip that found everything are both `done`, and what separates them is the report — which is what a reader wanted in the first place.

A trip log is capped at the most recent 500 rows per tripwire, pruned as each trip is written, and **only a terminal status is ever pruned**. A `running` row is state rather than log. The prune names the terminal statuses rather than negating the live ones, so a status a build has not learned costs a row and can never cost a question.

## The report is the trip's ending, and it is not a word the model chose

A trip ends by **ending its turn**. There is no resolution verb, no `--quiet`, no `--awaiting`, and no `dismiss`: the engine reads the last words of the session's final turn off the transcript and keeps them as the trip's report. The one rule the engine appends to the brief says where the answer goes and nothing about what the answer is — *end your turn with a short report of what you found and what you did* — so the brief remains the whole of the instruction.

This replaced a shape that failed on the first tripwire ever laid. The exits were a menu, the appended paragraph inviting one of them beat a brief that said "do not fix anything", and the sentence the brief actually asked for was written into a transcript and discarded because no exit could carry it. A report carries it by construction: there is nothing to choose, so there is nothing to choose wrong.

**The rounds count is the other half and is read the same way** — off the arc, as a difference, rather than out of anything the session said about itself.

## A trip is bounded, by wall clock and by tool calls

Every tripwire carries `max_seconds` and `max_tool_calls`, with defaults of 120 and 30, so a tripwire laid without a thought about cost is still bounded. Past either, the engine interrupts the session with the same frame the user's own stop sends, waits a short grace for the turn to end, closes the session, and fails the trip **naming which cap it met**.

They are columns rather than engine constants because the right numbers are a question a week of armed tripwires answers, and a rebuild should not be what it costs to change them. The grace is a bound on the wait rather than on the session: a session that ignores the interrupt is closed anyway, because a wedged bridge is exactly what the close is the backstop for. **A capped trip keeps its transcript**, so it is still a trip a reader can open and see how the budget went.

The tool-call count is the bridge's, because the bridge is the only place that sees every tool call: the engine never reads the stream. Nothing resets it mid-trip — a cap is what a trip costs in total, not what it costs since somebody last looked.

## A running trip opens its own Session card

A trip is an ordinary Tug session with hands, and the deck is where sessions are seen. The engine seats the session and writes its id onto the trip row the moment it has one, and a headless controller on the Tripwires card opens a Session card bound to it.

**It never takes the key view.** The card arrives with the first-responder flip suppressed, the focused-card write suppressed, and — the one that would be quietly dropped — the reveal that would travel the band to the new card suppressed too. A card that takes no first responder but scrolls the deck to itself has still taken the user's view. A trip arriving while somebody is mid-thought must not move the work out from under them, and the row's own **Open session** raises that card rather than opening a rival on a session the deck already holds.

**The engine does not read a card's arrival as an ending.** A trip is not over because somebody is watching it; it is over when its session is done. What keeps a carded session alive past the end of a trip is the close's own guard, which refuses to close a session another card holds — and that guard is the only place a card id is read.

## The own-session guard and the laid-by stamp

Both exist so a tripwire cannot chase its own tail, and both are exact rather than heuristic.

- **A tripwire never fires on a fact its own trip's session recorded.** A trip's session runs shell commands and writes files like any other session, and every one of those is a fact; a tripwire that read its own session's facts would fire forever. The guard is a ledger question — is this session id on a trip row of *this* tripwire — so it is exact, it costs one query, and it is **silent**: a trip's own noise is not news, and a row per shell command a trip ran would bury the log it is meant to be read from. That guard plus the one-live-run slot is the whole anti-loop defense; the tripwire's `--scope` is a decision about coverage and is never a defense.
- **The arc a tripwire owns is stamped with who laid it.** `tugarc_core::ops::set_laid_by` writes `tripwire/<name>` to a git config key on the arc, which is what badges the arc in the Arcs card as a tripwire's work rather than a person's. A tripwire may author work and say so; landing it is the user's act, always, and `arc join` is never a tripwire's to run.

## A tripwire is written at a slash command, and the card carries the knobs

The door is `/tripwire` in the Session card's prompt entry, driving `tugtool tripwire` underneath. The terminal is never required for any of it, and the card never grows a lay form: the fields where a wrong value makes a tripwire silently useless rather than visibly wrong — the trigger, the scope, the probe, the caps, and above all the brief — are written where there is a conversation to get them right in, and read back on the card in English rather than in the enums the ledger holds.

**The card shows a description and never the brief.** Every tripwire carries a required one-sentence `description`, written through the skill beside the brief, and that sentence is what the fold leads with. The brief is the prompt a trip runs on: addressed to the model, hundreds of words long, and no part of what a reader of a sidebar is reading for. It was tried bare, then behind a tooltip, then behind a two-line clamp, and each of those is the same wall of text one gesture further away — so it is off the card entirely, and stays where it is read back from: the ledger, the roster projection, and `tugtool tripwire list --json`.

What the card carries instead is the small set of knobs and verbs a reader of a trip log reaches for without leaving it: pause and model as knobs, and Pause/Resume, Trip now, Open session and **Delete** as verbs. Delete is the one that destroys something, so it sits last on the row's `⋯` menu behind a separator and behind a danger-role confirm naming the trip log and the tripwire's own arc, and it is **refused while a trip is running**, with the refusal in the item's own label. The removal itself is one guarded operation the card and `tugtool tripwire rm` both stand on, so the two doors cannot disagree about the rule, and the tripwire's arc is discarded with the row rather than orphaned by a cascading delete. The skill is the one user-facing document for the half where a tripwire is written, and it ships inside the bundle, so it may not cite this file — a project Tug opens has no `tuglaws/` and nothing in the skill may depend on one.

## One projection, three callers

The request surface, the roster feed, and `tugtool tripwire list` all compute a tripwire's live state through the same projection, so the card, the feed and the command line cannot disagree about whether a tripwire is running. It is a **library function rather than an endpoint**, and that is forced: the CLI has to work with the app closed.

The projection returns a `Result` and never hides a failed read. A read that fails must reach the caller and be said, because the frame carries an error field for exactly that — the alternative, which this replaced, answered a healthy-looking roster of `false` when a tripwire that was running reported as idle and nobody was told.

## The observation model: the probe is the correctness, the nudges are latency

The roster is pushed on a snapshot feed rather than polled by the card. What makes it correct is the ledger's own `PRAGMA data_version`, not the bumps: four parties write the tripwire ledger — this process's engine, this process's request surface, a `tugtool tripwire` in another process, and **another instance's engine, which has no door to reach this process through at all**. `data_version` moves on every other connection's commit, so a nudge that was never added, or one that was missed, costs latency rather than correctness.

Every `bump()` in the codebase exists to remove that latency and **nothing rests on one**. The probe is the named exception to the project's no-polling rule, and the exception is narrow: the event is real and only its *observation* is polled, for the one writer with no door. A bump is coalesced behind a floor so a burst that settles several trips in quick succession costs one compose; a snapshot equal to the last is suppressed.

The per-tripwire trip log stays a request rather than joining the feed, because it is per-tripwire and up to 500 rows while the roster is small and always shown. The card re-asks a log whose revision moved, which is why the window the revision hashes may never be narrower than the window the request surface will hand out — a revision computed over a shorter window would let a change past its edge go unnoticed in a log the card is showing.

## Registered decisions

[D197] (one bounded session with hands, on the tripwire's own arc, that always reports and can always be watched) is the standing decision; it supersedes [D189] and amends the rest. [D190] (the provenance guards), [D191] (a trip is a session, not an arc), [D192] (the slash-command door), [D193] (the observation model) and [D196] (the fact-time trigger) are kept for what each settled, in [design-decisions.md](design-decisions.md).
