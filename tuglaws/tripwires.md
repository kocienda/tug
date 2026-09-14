# Tripwires

A **tripwire** is a standing condition on what sessions do: it sits on the machine doing nothing until a session records a **fact** of the kind it names, then fires a **trip** that runs a probe, asks a read-only session about what the probe could not settle, and raises its hand only when it has something a person should see.

This document is the feature's durable doctrine — the lifecycle, the guards, and the rules that are arguments rather than implementation details. The authoring door and its judgement are the `/tripwire` skill's, which ships in the bundle and stands alone; the trip engine is `tugcast::feeds::tripwire`, the ledger is `tugtool_core::tripwire_ledger`, the projection every surface reads is `tugtool_core::tripwire_roster`, the roster feed is `tugcast::feeds::tripwires`, the request surface is `tugcast::tripwires_api`, and the surface is `tugdeck/src/components/tripwires/`.

## Only a recorded fact fires one

Work done outside a Tug session is invisible to the whole facility — a `git commit` typed in a terminal records no fact and fires nothing. That is the design rather than a gap: the session ledger is the one place that knows what happened, which session it happened in, and which checkout that session was working in, so it is the one place a firing can be built from without guessing.

**The trigger is the fact being recorded, and nothing else.** A tripwire named for a shell command that failed fires when that command fails, at the moment the ledger writes it — not later, when something is committed, and not against a window of facts looked back over. The engine sees each fact exactly once, on the process-global channel `session_ledger::record_fact_tx` writes to after its insert commits, which is why there is no ceiling to keep and no lookback to get wrong. A condition about a commit is a condition on the `commit` fact, whose payload carries the branch it went onto.

## A trip is a session, never an arc

An arc is a walk over a ledger with stages and document-shaped facts. A trip has no plan, no steps, and ends in a resolution verb, so it is not put on the arc runner and never appears in the Arcs card. The arc enters only where a diagnosis asks for authoring, and *that* arc is an ordinary arc — shown in the Arcs card, joined or discarded by the user like any other. Trips are shown in the Tripwires card and nowhere else. This is worth revisiting only if a trip ever acquires steps worth pacing.

## The lifecycle, over six statuses

A trip's row is written once, by the decision that made it, and then transitions in place. Every guard runs *before* the row exists, so a refusal is a row minted `skipped` with its reason on it rather than a claim taken back — one event is one row per tripwire, which the ledger's `UNIQUE(tripwire_id, event_key)` constraint promises and the `INSERT OR IGNORE` behind every write keeps true however many instances race.

- **`skipped`** — it did not run, and the row's reason says which: `busy` (this tripwire already has a live trip), `ceiling` (the machine is at its trip limit), `no-room` (the host had no room for a session). **There is no queue.** A tripwire asked to verdict five events in a storm wants the last one's verdict rather than five worktrees, and the honest way to say that is a visible row saying the trip did not run — a queue that coalesced to the newest was the same answer wearing a mechanism, and it cost two statuses to express.
- **`running`** — a probe or a session is working it now. Its session id is on the row from the moment the supervisor seats the session rather than when the phase returns, so a trip that is working is a trip the card can open.
- **`quiet`** — finished, having found nothing worth the user's attention. The row stays, and so does its session.
- **`awaiting`** — finished with something the user should see, and holding until they see it.
- **`failed`** — finished without an outcome: a session that died, or one that ended its turn without running the verb. A host at its spawn budget is not this — that is a `skipped` row reading `no-room`, because busy is not broken.
- **`adopted`** — a deck card took the trip's session over. Not finished, because the session is alive and may still run the verb; not running either, because the engine has stopped watching it.

A trip log is capped at the most recent 500 rows per tripwire, pruned as each trip is written, and **only a terminal status is ever pruned**. A `running`, `awaiting` or `adopted` row is state rather than log — an awaiting one is holding a question that may stand for weeks, and pruning it would orphan the arc it authored, which nothing would then settle. The prune names the terminal statuses rather than negating the live ones, so a status a build has not learned costs a row and can never cost a question.

**Every trip is visible, and a trip that had a session keeps it.** A quiet resolution is a row on the card whose session is still openable rather than a firing nobody can see the workings of; the card's band counts the trips a tripwire has run, and Open session reaches the newest trip that had one whatever state it ended in. The one row that folds in the log is the probe-settled trip — no headline, no session — because there is nothing behind it to open.

## A trip stands in a disposable tree, never in the user's checkout

A probe is an arbitrary shell command off a tripwire row and a diagnosis session is a model with a shell, so the only honest place to run either is somewhere nobody keeps. A trip's tree is a detached `git worktree` cut at the **`HEAD` of the checkout the fact was recorded in**, under one tripwire-owned scratch root — a commit that exists, in a directory the trip may write to freely and that goes when the trip does.

**`HEAD` rather than the fact's own moment, and the uncommitted half travels beside it.** There is no commit for "what the working copy looked like when this shell command failed", and inventing one would put the user's uncommitted work into a tree they never asked for. So the tree is the last commit they made, and what they had not committed is written next to it as a single `<trip_id>.diff` file — `git diff HEAD` under a `git status --porcelain` header — which the prompt names and summarises. A session that wants those bytes opens one file; a session that does not is standing in a checkout that is exactly a commit.

**One tree per sha, one diff per trip.** A dozen tripwires meeting one fact share one checkout, refcounted and removed when the last trip standing there settles; the diff is per trip, because two trips at one sha were cut at two different moments and a working copy is not the same thing twice. Both are swept against the ledger — trees against the shas with live trips, diffs against the live trip ids — because a crash leaves a detached worktree that no registry lists, and a sweep that is a directory listing needs no registry to answer.

## One live run per tripwire, and why `adopted` does not hold it

A tripwire with a trip `running` or `awaiting` is not evaluated; the skip is a row reading `busy`. An awaiting trip holds no process, but it holds a question the user has not answered and an arc they may still join, and firing the tripwire again underneath that would replace the question with a newer one nobody asked for.

`adopted` is deliberately absent from that guard, and the absence is the decision. Once a card has taken the session over, the trip belongs to the user rather than to the engine, and there is no reason the tripwire may not fire again while they work in it. This is the one read where `adopted` and the live set part company: the busy guard asks *may the tripwire fire again?* and an adopted trip is no reason it may not, while the inspection-tree read asks *is anything still using the tree?* and an adopted session plainly is — so `adopted` counts there and not here.

## How an awaiting trip is released — two ways, neither a clock

Nothing in this feature does what it does forever, and an awaiting trip is the one place that could have. It is not released by a timeout, because a question that evaporates overnight is a question nobody was asked; it is released by being **answered**, and there are exactly two answers:

- **The arc's own fate.** A trip that authored an arc is released when that arc is joined or discarded, which is itself the answer to the question the tripwire asked. The engine's sweep runs on its tick and ahead of every fact's guards, because what it releases is the tripwire's live-run slot. Its compare-and-set is not decoration: `tripwire dismiss` settles the same row from another process and discards the same arc, so a sweep arriving mid-dismissal must lose rather than overwrite the dismissal's words.
- **A gesture on the card.** A trip that authored no arc has no fate to wait on, so the register band under its row carries a **Seen** act, which is `dismiss` with nothing to discard. The row menu's **Release** is the same verb under the keyboard's name.

## The own-session guard and the laid-by stamp

Both exist so a tripwire cannot chase its own tail, and both are exact rather than heuristic.

- **A tripwire never fires on a fact its own trip's session recorded.** A diagnosis or authoring session runs shell commands and writes files like any other session, and every one of those is a fact; a tripwire that read its own session's facts would fire forever. The guard is a ledger question — is this session id on a trip row of *this* tripwire — so it is exact, it costs one query, and it is **silent**: a trip's own noise is not news, and a row per shell command a trip ran would bury the log it is meant to be read from. That guard plus the one-live-run slot is the whole anti-loop defense; the tripwire's `--scope` is a decision about coverage and is never a defense.
- **An arc a tripwire authored is stamped with who laid it.** `tugarc_core::ops::set_laid_by` writes `tripwire/<name>` to a git config key on the arc, which is what badges the arc in the Arcs card as a tripwire's work rather than a person's. A tripwire may author work and say so; landing it is the user's act, always, and `arc join` is never a tripwire's to run.

## Authoring is a slash command, and the card carries the knobs

The door is `/tripwire` in the Session card's prompt entry, driving `tugtool tripwire` underneath. The terminal is never required for any of it, and the card never grows a lay form: the fields where a wrong value makes a tripwire silently useless rather than visibly wrong — the trigger, the scope, the probe, and above all the brief — are authored where there is a conversation to get them right in, and read back on the card in English rather than in the enums the ledger holds.

**The card shows a description and never the brief.** Every tripwire carries a required one-sentence `description`, authored through the skill beside the brief, and that sentence is what the fold leads with. The brief is the prompt a trip runs on: addressed to the model, hundreds of words long, and no part of what a reader of a sidebar is reading for. It was tried bare, then behind a tooltip, then behind a two-line clamp, and each of those is the same wall of text one gesture further away — so it is off the card entirely, and stays where it is read back from: the ledger, the roster projection, and `tugtool tripwire list --json`.

What the card carries instead is the small set of knobs and verbs a reader of a trip log reaches for without leaving it: pause and model as knobs, and Pause/Resume, Trip now, Open session, Release and **Delete** as verbs. Delete is the one that destroys something, so it sits last on the row's `⋯` menu behind a separator and behind a danger-role confirm naming the trip log and the arc an awaiting trip is holding, and it is **refused while a trip is running**, with the refusal in the item's own label. The removal itself is one guarded operation the card and `tugtool tripwire rm` both stand on, so the two doors cannot disagree about the rule, and an awaiting trip's arc is discarded through the dismiss path rather than orphaned by a cascading delete. The skill is the one user-facing document for the authoring half, and it ships inside the bundle, so it may not cite this file — a project Tug opens has no `tuglaws/` and nothing in the skill may depend on one.

## One projection, three callers

The request surface, the roster feed, and `tugtool tripwire list` all compute a tripwire's live state through the same projection, so the card, the feed and the command line cannot disagree about whether a tripwire is running. It is a **library function rather than an endpoint**, and that is forced: the CLI has to work with the app closed.

The projection returns a `Result` and never hides a failed read. A read that fails must reach the caller and be said, because the frame carries an error field for exactly that — the alternative, which this replaced, answered a healthy-looking roster of `false` when a tripwire that was running reported as idle and nobody was told.

## The observation model: the probe is the correctness, the nudges are latency

The roster is pushed on a snapshot feed rather than polled by the card. What makes it correct is the ledger's own `PRAGMA data_version`, not the bumps: four parties write the tripwire ledger — this process's engine, this process's request surface, a `tugtool tripwire` in another process, and **another instance's engine, which has no door to reach this process through at all**. `data_version` moves on every other connection's commit, so a nudge that was never added, or one that was missed, costs latency rather than correctness.

Every `bump()` in the codebase exists to remove that latency and **nothing rests on one**. The probe is the named exception to the project's no-polling rule, and the exception is narrow: the event is real and only its *observation* is polled, for the one writer with no door. A bump is coalesced behind a floor so a burst that settles several trips in quick succession costs one compose; a snapshot equal to the last is suppressed.

The per-tripwire trip log stays a request rather than joining the feed, because it is per-tripwire and up to 500 rows while the roster is small and always shown. The card re-asks a log whose revision moved, which is why the window the revision hashes may never be narrower than the window the request surface will hand out — a revision computed over a shorter window would let a change past its edge go unnoticed in a log the card is showing.

## Registered decisions

[D189] (the lifecycle and the release rule), [D190] (the provenance guards), [D191] (a trip is a session, not an arc), [D192] (the slash-command door), [D193] (the observation model), and [D196] (the fact-time trigger, the HEAD tree, and the six statuses) in [design-decisions.md](design-decisions.md).
