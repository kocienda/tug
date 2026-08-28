## Tripwire, machine-global

Machine-global changes the storage and the evaluation story, and it's worth being precise about both.

**Store:** a new machine-global `tripwires.db` beside `changes.db`, `prompt_history.db`, and `apptest_results.db`, opened through `tugcore::ledger_db` like every other ledger. Two tables: `wires` (name, trigger predicate, scope, probe, brief, model, permission posture, paused, cooldown) and `trips` (the trip log — every firing, including cooldown-swallowed ones, with probe output, agent transcript pointer, verdict, and outcome). The precedent for "machine-global because the corpus belongs to the user, not an instance" is exactly `prompt_history.db`.

**Evaluation:** events are per-instance — facts, broadcast feeds, and `GIT_HEAD` all live inside each tugcast. So every tugcast instance runs a tripwire engine reading the shared `wires` table and evaluating against *its own* event streams. Machine-global store, local eyes. This is what makes the rev wire work: it's one row, and whichever instance's session trips it is the one that responds. Two refinements this forces:

- **Per-wire scope, not per-store scope.** A wire carries an optional scope — a path pattern, or none. The rev wire is unscoped (a rev failure anywhere on the machine trips it); the CI wire is scoped to the tugtool checkout. Machine-global storage with per-wire scoping gives you both of your examples from one table.
- **Trip dedup in the shared table.** If two instances ever observe the same underlying event (two tugcasts watching one checkout can both see a `GIT_HEAD` move), the trip is claimed by inserting a `(wire, event_key)` row into `trips` — a unique constraint makes the second claimant lose silently. The ledger writer-lock discipline already handles the concurrent-writer mechanics.

**No tugbank for wire state** — tugbank is per-instance, and wire state must travel with the wire. Model, pause, cooldown are columns on the wire row, read at trip time. The engine re-reads the wire set when evaluating a candidate event (the table is tiny), so `tugutil wire pause ci-confidence` takes effect on the next event with no notification plumbing at all.

## The work tier, designed now

A work-tier wire's response is a **real headless tugcode session**: a genuine session id, a genuine transcript, spawned through the supervisor beside `spawn_session` via a new cardless entry point (the exploration confirmed the current path is client/card-scoped, so this is a supervisor addition, not a hack around it). Three design commitments:

**1. Work runs in a disposable worktree, never in your tree.** The commit wire's probe runs `just fix && just ci` — and `just fix` *writes*. An autonomous process must never mutate the checkout you're working in, race your uncommitted files, or leave attribution debris in your session's ledger. So a work-tier trip forks a scratch worktree at the triggering commit (the dash machinery already knows how to do this), the probe and the agent both operate there, and the worktree is destroyed after the trip — unless the agent produced a fix, in which case the diff is preserved as the trip's artifact. Applying it is your gesture: the Overview post offers the patch, you take it or leave it. The wire never lands anything.

**2. Adoptable, not invisible.** Headless doesn't mean hidden. The session is a real session, so "see the workings" is free: the Overview post carries a ref to it, and opening that ref seats the session on a card — live if it's still running, transcript if it's done. You can watch it work, interrupt it, or take over the conversation. This is much better than a bespoke progress view, and it costs almost nothing because it's what sessions already do.

**3. Per-wire permission posture.** A column, not a global: the rev wire runs read-only (it diagnoses and proposes a corrected rev — it doesn't need hands), the CI wire runs `acceptEdits` *inside its worktree*. The worktree boundary is what makes the permissive posture safe to default: the blast radius of a misbehaving wire is a directory that gets deleted.

The verdict tier (SharedAgentPool, no tools, no session) survives as an optimization the engine picks automatically: a wire with no probe and a read-only brief doesn't need a worktree or a session, so it gets the cheap path. But it's an internal fast path, not a capability boundary — every wire *may* have hands.

## Routine vs. interesting

Two mechanisms, layered, because "interesting" has a cheap deterministic floor and an irreducibly judgment-shaped remainder:

**The engine decides the easy cases without spending tokens.** Green probe, no agent run → routine: one line in the trip log, nothing in the Overview. Every commit that passes `just ci` costs zero tokens and zero attention. Probe failure → automatically interesting (the agent runs, and its report posts). This floor alone handles the commit wire correctly.

**The agent classifies the rest.** When an agent does run, its required closing envelope — same strict-JSON discipline as the Observer's `{"post": null}` contract — is `{"interest": "routine" | "interesting", "headline": …, "refs": […]}`. A rev failure the agent recognizes as the user's typo mid-experiment can come back routine; the same exit code from a resolver bug in tugrev itself comes back interesting with the diagnosis as the post. The model is the only thing positioned to make that call, and the envelope makes it a forced, auditable choice rather than a vibe.

**Per-wire override:** `post = auto | always | never`. `always` is how you shake down a freshly laid wire; `never` turns a wire into a pure logger. The trip log records everything regardless — the Overview is the attention surface, the log is the record.

In the Overview, trips post under the **Tripwire** author (new `OverviewAuthor` variant, wire name attached, distinct glyph) — the fourth participant, as you pictured. A work-tier trip posts at spawn ("wire *ci-confidence* tripped by `858a40e4f`, working…") so a long run is visible while it's live, with the verdict post replacing the placeholder when it settles.

## Surface

```
tugutil wire lay <name> [--on <trigger>] [--scope <path>] [--probe <cmd>] [--brief <text|file>] [--model <m>] [--permissions <mode>]
tugutil wire list | edit | rm | pause | resume
tugutil wire log <name>          # the trip log, full workings
tugutil wire trip <name>         # fire it by hand — how you test a wire without waiting for lightning
```

`wire trip` matters more than it looks: a wire you can't fire deliberately is a wire you can't debug. Deck UI (a wires section, per-wire toggle, trip history) comes after the CLI and the Overview integration prove the loop — the Overview posts and adoptable sessions mean you have full visibility from day one without any new deck surface.

The one piece of groundwork that precedes all of it: **`rev_failed` becomes a first-class fact**, emitted from `rev.rs` with the program text and error report, because today a failed rev evaporates into stderr. Triggers are predicates over facts; anything worth tripping on must leave a fact.

That's the full shape — machine-global single-table wires with local evaluation, work tier in disposable worktrees with adoptable sessions, and a two-layer interest filter so the Overview only speaks when there's something to say. Where do you want to push on it?