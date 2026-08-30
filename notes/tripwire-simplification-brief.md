# Tripwire simplification — the engine

The first real-world tripwire run surfaced four defects, and three of them trace to one root: the work tier was built as a session that runs, not as a session whose output anyone receives. Its verdict was scraped out of prose by an envelope parser that broke on the first real transcript; its dash was born unjoinable because `TUG_SESSION_ID` was stripped to prevent self-triggering; its cleanup handed an abandoned worktree's bytes back onto the base checkout because it reused a discard path built to protect a user's carried work. Rather than patch each, this brief deletes the machinery they lived in and rebuilds tripwires on tighter ground.

This is the first of two briefs. It rebuilds the engine end to end and leaves tripwires shippable and useful. The second — [background-session-card-adoption-brief.md](background-session-card-adoption-brief.md) — builds the click-through that opens a card onto a background session, which is a general capability rather than a tripwire part. **This work does not depend on it and must not wait for it.**

## The new constraints

**A tripwire names its base branch, and runs only against it.** Never against a dash or any other worktree. The wire's definition carries the branch name explicitly, and the existing wire definitions are migrated to name theirs.

**A tripwire fires only when a landing gesture commits onto that branch.** The trigger rides Tug's own landing path — `/commit` and `/dash-join` — not a git watcher. When a landing completes, the engine evaluates every armed wire's condition against the facts of the sessions that produced that commit, and fires the ones that match. This is the whole trigger model: no mid-session firing, no racing live work. A hand-typed `git commit` outside Tug's landing gestures does not fire a wire; that is the accepted trade for perfect provenance and zero polling.

**A fired tripwire is an ordinary session.** Real `TUG_SESSION_ID`, real claims, spawned as a normal tugcode/tugcast session in the background with no card surface — the same session anyone could open a card on. The `.env_remove("TUG_SESSION_ID")` strip is deleted; nothing about the session is special except how it was started and what it was handed.

**The engine assembles the dossier.** "Full access to the material that led to the commit" arrives as an opening context the engine builds at landing time, not a scavenger hunt: the commit sha and diff stat, the fact rows that tripped the wire, and the transcript paths for the commit's full session lineage — the drafting session for a `/commit`; for a join, the dash's bound sessions with lineage unioned from both sources, because session ids rotate. The landing path just computed all of this; the tripwire session must never reconstruct provenance.

**The dash is created lazily, or never.** The session's first phase is diagnosis — reading transcripts, facts, the diff — which is read-only and needs no worktree. Only at the moment it decides it has a change to author does it run `tugtool dash create` against the named base branch and work there, under ordinary dash discipline. Most runs end without one. This collapses the old verdict/work tier split into one shape: every tripwire run is the same kind of session, and the dash is a thing it reaches for, not a thing it is born with.

**The run's decision is a verb, never parsed prose.** The session ends by calling a resolution verb with exactly two outcomes: *awaiting* — it has something the user should see — or *quiet* — nothing actionable, go back to sleep. A tool call is attributable, unambiguous, and testable. A session that dies without calling the verb settles as quiet after a ceiling, with the failure logged on the wire's trip log. The envelope contract (`interest`/`outcome`/`headline`/`refs`), its parser, and the frames-within-frames bug class are deleted whole.

**Awaiting means a steady yellow dot and a session that keeps its history.** The Lens row shows a pulsing dot while the session runs, exactly as a session card does; on *awaiting* the dot goes steady yellow. The session's last turn ends on a leading question written as prose in the transcript — its case, its evidence, and the choice it is putting to the user — because a pending `QuestionDialog` would require tugcast to hold an unanswered control request for a cardless session indefinitely. Until the second brief lands, the user reaches an awaiting wire's work the ordinary way: the dash is real, bound, and joinable like every other dash.

**Quiet means clean disappearance.** If the run created a dash, the engine discards it with **no hand-back, ever**. `discard_in`'s hand-back exists to protect a user's `--carry` work; a tripwire dash is an agent's dash, and nothing in its abandoned worktree belongs on anyone's base checkout. This is the one old defect the new design does not erase structurally — the cleanup path must be changed, with a test pinning that an abandoned tripwire dash leaves the base checkout byte-identical.

## Anti-loop, without the hacks

The old design prevented self-triggering by hiding the session's identity. The new design prevents it with two provenance rules, and needs no hiding:

- **A wire never fires on a commit that came from its own dash.** The join commit's `Tug-Dash:` trailer names the branch; the wire skips it.
- **Facts are spent at the high-water mark.** Each wire records the last commit it evaluated; facts at or before that mark never fire it again. The same `edit_failed` rows cannot trip the wire twice across successive landings.

Together these replace the cooldown timer. The remaining concurrency rule is: **one live run per wire** — a wire that is running or awaiting does not re-fire; the next landing re-evaluates whatever the skipped one would have seen. An awaiting wire therefore holds its slot until it is resolved, and the plan must say for how long and what resolves it.

## What gets deleted

The envelope contract and `parse_tripwire_envelope`; the verdict/work tier split and the pooled `claude -p` workers; the `TUG_SESSION_ID` strip; the 20-minute ceiling as a tier property (the settle ceiling above replaces it); the cooldown knob; the post-to-Overview policy knob and the routine/interesting distinction — the dot is the interest signal, and at most, going awaiting drops one pointer in the Overview. The Lens row keeps: name, base branch, pause/arm, dot state, and the last-trip line.

## What is retired conceptually

The old design could catch things mid-session, before a commit existed. This design trades that away deliberately: a tripwire is a **post-commit inspector**, not a live smoke alarm. It reads the completed story — including every dash session behind the landing — and diagnoses from evidence instead of racing the work that is producing it. The `tugedit-doctor` incident is the argument: the racing design corrupted the very checkout it was meant to help.

## Scope

**In:** the landing-gesture trigger and per-wire evaluation; the dossier assembly; the ordinary-session spawn with lazy dash creation; the resolution verb and settle ceiling; the two provenance guards; the no-hand-back cleanup with its base-untouched test; the Lens row states (pulsing, steady yellow awaiting, asleep); deletion of the envelope parser, tier split, and retired knobs; migration of the existing wire definitions to name their base branch.

**Out:** opening a card on the tripwire's session — that is the second brief, and the awaiting state is deliberately a dot with no click-through here. `QuestionDialog` held across adoption. Firing on git commits made outside Tug's landing gestures. Any change to what facts the ledger records or how sessions claim files. The wires watch Tug's landings, and that boundary is the design.
