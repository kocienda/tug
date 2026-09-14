# Tripwires

A **tripwire** is a standing post-commit inspector: it sits on the machine doing nothing until a landing gesture puts a commit on the branch it names, then fires a **trip** that runs a probe, asks a read-only session about what the probe could not settle, and raises its hand only when it has something a person should see.

This document is the feature's durable doctrine — the lifecycle, the guards, and the rules that are arguments rather than implementation details. The authoring door and its judgement are the `/tripwire` skill's, which ships in the bundle and stands alone; the trip engine is `tugcast::feeds::tripwire`, the ledger is `tugtool_core::tripwire_ledger`, the projection every surface reads is `tugtool_core::tripwire_roster`, the roster feed is `tugcast::feeds::tripwires`, the request surface is `tugcast::tripwires_api`, and the surface is `tugdeck/src/components/tripwires/`.

## Only Tug's own landing gestures fire one

A `git commit` typed in a terminal, or a commit made by any tool outside Tug, is invisible to the whole facility. That is the design rather than a gap: the landing gesture — the Session card's commit, or an arc join — is the one place that knows the branch, the commit, and the sessions whose work went into it, so it is the one place a firing can be built from without guessing. A tripwire's `--branch` is *when* it fires and its `--on fact:<kind>` is *what*; the branch is stored on the tripwire rather than buried in the trigger, because the same watch on two branches is two different watches.

## A trip is a session, never an arc

An arc is a walk over a ledger with stages and document-shaped facts. A trip has no plan, no steps, and ends in a resolution verb, so it is not put on the arc runner and never appears in the Arcs card. The arc enters only where a diagnosis asks for authoring, and *that* arc is an ordinary arc — shown in the Arcs card, joined or discarded by the user like any other. Trips are shown in the Tripwires card and nowhere else. This is worth revisiting only if a trip ever acquires steps worth pacing.

## The lifecycle, over nine statuses

A trip's row is minted by a claim and then transitions in place. Every guard runs *after* the claim, so a refusal is a status on the row the claim made rather than a second row beside it — one event is one row per tripwire, which is what the ledger's `UNIQUE(tripwire_id, event_key)` constraint already promises, and a refusal writing its own row would quietly break that promise the first time two instances raced.

- **`claimed`** — this instance won the `INSERT OR IGNORE` and owns the firing. Two tugcasts watching one workspace see the same landing, and that constraint is the whole of the arbitration between them; it is only arbitration because the ledger is machine-global rather than per-instance.
- **`swallowed`** — refused before any work, carrying the reason: a tripwire already busy, a landing of the tripwire's own arc, a paused tripwire.
- **`queued`** — serviceable, but the machine is at its ceiling or the tripwire is busy. The engine starts the oldest queued trip when one of its own runs settles.
- **`superseded`** — a newer queued event for this tripwire replaced this one. There is one queue slot per tripwire, because coalescing to the newest pending event is what a tripwire actually wants: a tripwire asked to verdict five commits in a storm wants the last one's verdict, not five worktrees. The superseded row stays in the log, so the coalescing is visible.
- **`running`** — a probe or a session is working it now.
- **`settled`** — finished, with an outcome.
- **`awaiting`** — finished with something the user should see, and holding until they see it.
- **`failed`** — finished without an outcome: a session that died, or one that ended its turn without running the verb. A host at its spawn budget is not this — that is a trip put back to `queued`, because busy is not broken.
- **`adopted`** — a deck card took the trip's session over. Not finished, because the session is alive and may still run the verb; not running either, because the engine has stopped watching it.

A trip log is capped at the most recent 500 rows per tripwire, pruned at claim time, and **only a terminal status is ever pruned**. A `claimed`, `queued`, `running`, `awaiting` or `adopted` row is state rather than log — an awaiting one is holding a question that may stand for weeks, and pruning it would orphan the arc it authored, which nothing would then settle. The prune names the terminal statuses rather than negating the live ones, so a status a build has not learned costs a row and can never cost a question.

## One live run per tripwire, and why `adopted` does not hold it

A tripwire with a trip `running` or `awaiting` is not evaluated; the skip is a row reading `busy`. An awaiting trip holds no process, but it holds a question the user has not answered and an arc they may still join, and firing the tripwire again underneath that would replace the question with a newer one nobody asked for.

`adopted` is deliberately absent from that guard, and the absence is the decision. Once a card has taken the session over, the trip belongs to the user rather than to the engine, and there is no reason the tripwire may not fire again while they work in it. This is the one read where `adopted` and the live set part company: the busy guard asks *may the tripwire fire again?* and an adopted trip is no reason it may not, while the inspection-tree read asks *is anything still using the tree?* and an adopted session plainly is — so `adopted` counts there and not here.

## How an awaiting trip is released — two ways, neither a clock

Nothing in this feature does what it does forever, and an awaiting trip is the one place that could have. It is not released by a timeout, because a question that evaporates overnight is a question nobody was asked; it is released by being **answered**, and there are exactly two answers:

- **The arc's own fate.** A trip that authored an arc is released when that arc is joined or discarded, which is itself the answer to the question the tripwire asked. The engine's sweep runs on its tick and ahead of every landing's guards, because what it releases is the tripwire's live-run slot. Its compare-and-set is not decoration: `tripwire dismiss` settles the same row from another process and discards the same arc, so a sweep arriving mid-dismissal must lose rather than overwrite the dismissal's words.
- **A gesture on the card.** A trip that authored no arc has no fate to wait on, so the register band under its row carries a **Seen** act, which is `dismiss` with nothing to discard. The row menu's **Release** is the same verb under the keyboard's name.

## The two provenance guards

Both exist so a tripwire cannot chase its own tail, and both are exact rather than heuristic.

- **A tripwire never fires on the landing of its own arc.** The join that lands a tripwire's authored work is a landing like any other, and the tripwire that authored it is skipped for that landing **by name**, before the predicate runs — so the skip spends nothing. The refusal is written into the trip log as `own-arc`, which is what makes it visible rather than mysterious. That guard plus the one-live-run slot is the whole anti-loop defense; the tripwire's `--scope` is a decision about coverage and is never a defense.
- **An arc a tripwire authored is stamped with who laid it.** `tugarc_core::ops::set_laid_by` writes `tripwire/<name>` to a git config key on the arc, which is what badges the arc in the Arcs card as a tripwire's work rather than a person's. A tripwire may author work and say so; landing it is the user's act, always, and `arc join` is never a tripwire's to run.

## Authoring is a slash command, and the card carries the knobs

The door is `/tripwire` in the Session card's prompt entry, driving `tugtool tripwire` underneath. The terminal is never required for any of it, and the card never grows a lay form: the fields where a wrong value makes a tripwire silently useless rather than visibly wrong — the trigger, the scope, the probe, and above all the brief — are authored where there is a conversation to get them right in, and read back on the card in English rather than in the enums the ledger holds.

What the card carries instead is the small set of knobs and verbs a reader of a trip log reaches for without leaving it: pause and model as knobs, and Pause/Resume, Trip now, Open session and Release as verbs. The skill is the one user-facing document for the authoring half, and it ships inside the bundle, so it may not cite this file — a project Tug opens has no `tuglaws/` and nothing in the skill may depend on one.

## One projection, three callers

The request surface, the roster feed, and `tugtool tripwire list` all compute a tripwire's live state through the same projection, so the card, the wire and the command line cannot disagree about whether a tripwire is running. It is a **library function rather than an endpoint**, and that is forced: the CLI has to work with the app closed.

The projection returns a `Result` and does not swallow a failed read. A read that fails must reach the caller and be said, because the frame carries an error field for exactly that — the alternative, which this replaced, answered a healthy-looking roster of `false` when a tripwire that was running reported as idle and nobody was told.

## The observation model: the probe is the correctness, the nudges are latency

The roster is pushed on a snapshot feed rather than polled by the card. What makes it correct is the ledger's own `PRAGMA data_version`, not the bumps: four parties write the tripwire ledger — this process's engine, this process's request surface, a `tugtool tripwire` in another process, and **another instance's engine, which has no door to reach this process through at all**. `data_version` moves on every other connection's commit, so a nudge that was never added, or one that was missed, costs latency rather than correctness.

Every `bump()` in the codebase exists to remove that latency and **nothing rests on one**. The probe is the named exception to the project's no-polling rule, and the exception is narrow: the event is real and only its *observation* is polled, for the one writer with no door. A bump is coalesced behind a floor so a landing that settles several trips in quick succession costs one compose; a snapshot equal to the last is suppressed.

The per-tripwire trip log stays a request rather than joining the feed, because it is per-tripwire and up to 500 rows while the roster is small and always shown. The card re-asks a log whose revision moved, which is why the window the revision hashes may never be narrower than the window the request surface will hand out — a revision computed over a shorter window would let a change past its edge go unnoticed in a log the card is showing.

## Registered decisions

[D189] (the lifecycle and the release rule), [D190] (the two provenance guards), [D191] (a trip is a session, not an arc), [D192] (the slash-command door), and [D193] (the observation model) in [design-decisions.md](design-decisions.md).
