# Tripwire

A standing set of condition → response pairs that watch the same firehose the Overview watches. When a condition fires, an AI runs — scoped to that event — and reports what it found. The two motivating cases:

- **tugedit failures.** When a `tugutil file edit` program fails to resolve, an AI looks at the failure *right when it occurs*, diagnoses it, and proposes the corrected program.
- **Post-commit CI confidence.** After every commit on main, run `just fix && just ci` in a safe place and flag anything red, so a push to GitHub carries earned confidence.

## Vocabulary

The facility is **tripwire**. An instance is a **wire**; you **lay** a wire; a firing is a **trip**; the history is the **trip log**. Wires can be **paused** and **resumed**.

## The wire model

A wire is four things plus state:

- **Trigger** — a predicate over events (facts, feed frames).
- **Probe** — an optional plain command run when tripped. The machinery runs it, not the AI: no tokens spent on green runs.
- **Brief** — what the AI is asked to do with the event and the probe's output.
- **Model** — chosen per wire, read at trip time.

State: armed/paused, cooldown, permission posture, post policy, and the trip history.

The design move that keeps this cheap: **the AI runs on the residue, not the event.** A green `just ci` after a commit costs zero tokens and produces at most a quiet line in the trip log. The agent is summoned only when the probe fails or the wire has no probe (the event itself is the evidence).

## Storage and evaluation: machine-global store, local eyes

**Store:** a machine-global `tripwires.db` beside `changes.db`, `prompt_history.db`, and `apptest_results.db`, opened through `tugcore::ledger_db` like every other ledger. Two tables: `wires` (name, trigger predicate, scope, probe, brief, model, permission posture, post policy, paused, cooldown) and `trips` (the trip log — every firing, including cooldown-swallowed ones, with probe output, agent session pointer, dash pointer, interest, and outcome). The precedent for "machine-global because the corpus belongs to the user, not an instance" is `prompt_history.db`.

**Evaluation:** events are per-instance — facts, broadcast feeds, and `GIT_HEAD` all live inside each tugcast. Every tugcast instance runs a tripwire engine (a feed module, a sibling of `observer.rs` — never inside it, since the Overview's one-way isolation law [P12] forbids the Overview acting toward work) that reads the shared `wires` table and evaluates against its own event streams. This is what makes the tugedit wire work: one row, and whichever instance's session trips it is the one that responds.

- **Per-wire scope, not per-store scope.** A wire carries an optional scope — a path, or none. The tugedit wire is unscoped (a failure anywhere on the machine trips it); the CI wire is scoped to the tugtool checkout. Work-tier wires are inherently project-scoped, because dashes live in a checkout.
- **Trip dedup in the shared table.** If two instances observe the same underlying event (two tugcasts watching one checkout both see a `GIT_HEAD` move), the trip is claimed by inserting a `(wire, event_key)` row into `trips` — a unique constraint makes the second claimant lose silently.
- **No tugbank for wire state** — tugbank is per-instance, and wire state must travel with the wire. Model, pause, cooldown are columns on the wire row, read at trip time. The engine re-reads the wire set when evaluating a candidate event, so `tugutil wire pause ci-confidence` takes effect on the next event with no notification plumbing.

**Guards the engine enforces uniformly:** a cooldown per wire (a flapping trigger fires once, not forty times), one in-flight run per wire, and a trip-log row for every firing including the swallowed ones.

## The work tier runs on dash machinery

A work-tier trip **lays a real dash**. The wire's agent is a real headless tugcode session — genuine session id, genuine transcript, spawned through the supervisor beside `spawn_session` via a new cardless entry point — running on the dash worktree, committing there via `tugutil dash commit` under the existing dash commit discipline. The trip's artifact is not a loose patch; it is a dash with commits, an oplog, and documents at `.tug/dashes/<name>/`. Review happens in the Join sheet, landing is the user's `/dash-join <name>`, conflicts arrive as data, and `--resolve` stays a user-gesture-only act. **The wire stages; the user joins.** Wires only ever commit on their own dash worktree — exactly the exception the git policy already carves out.

- **Work runs in the dash worktree, never in your tree.** The CI wire's probe runs `just fix` — which writes. An autonomous process must never mutate the checkout you're working in, race your uncommitted files, or leave attribution debris in your session's ledger. The dash worktree is the disposable worktree.
- **Lazy dash, eager cleanup.** The dash is created at trip start (the probe needs somewhere safe to run) and **auto-removed if the trip ends with nothing committed**. A verdict-only outcome leaves no dash behind; only staged work persists.
- **Namespace and provenance.** Wire dashes carry a `laid_by: wire/<name>` provenance field and generated names like `wire-ci-confidence-858a40e`, so dash lists and the Join sheet can badge them rather than presenting work of unknown origin.
- **Adoptable, not invisible.** The session is a real session, so "see the workings" is free: the Overview post carries a ref to it, and opening that ref seats the session on a card — live if still running, transcript if settled. You can watch, interrupt, or take over.
- **Per-wire permission posture.** A column, not a global: the tugedit wire runs read-only (it diagnoses and proposes; it needs no hands), the CI wire runs `acceptEdits` inside its worktree. The worktree boundary is what makes the permissive posture safe: the blast radius of a misbehaving wire is a dash that gets deleted.

The **verdict tier** (a `SharedAgentPool` job — persistent `claude -p` workers, no tools, no session, no worktree; the same machinery the Observer and Operator run on) survives as an optimization the engine picks automatically for wires with no probe and a read-only brief. It is an internal fast path, not a capability boundary — every wire may have hands.

## Routine vs. interesting

Two mechanisms, layered, because "interesting" has a cheap deterministic floor and an irreducibly judgment-shaped remainder:

- **The engine decides the easy cases without spending tokens.** Green probe, no agent run → routine: one line in the trip log, nothing in the Overview. Probe failure → automatically interesting; the agent runs and its report posts.
- **The agent classifies the rest.** When an agent runs, its required closing envelope — the same strict-JSON discipline as the Observer's `{"post": null}` contract — is `{"interest": "routine" | "interesting", "outcome": "verdict" | "staged", "headline": …, "refs": […]}`. A tugedit failure the agent recognizes as a typo mid-experiment can come back routine; the same exit code from a resolver bug in tugedit itself comes back interesting with the diagnosis as the post. The envelope makes the call forced and auditable rather than a vibe.
- **A `staged` outcome is always interesting** — staged work is never routine by definition; the agent does not get to classify its own PR as boring.
- **Per-wire override:** `post = auto | always | never`. `always` is how you shake down a freshly laid wire; `never` makes a pure logger. The trip log records everything regardless — the Overview is the attention surface, the log is the record.

## Reporting: the fourth participant in the Overview

Trips post under a new **Tripwire** `OverviewAuthor` variant (wire name attached, distinct glyph); the deck's overview store learns to render it. A work-tier trip posts at spawn ("wire *ci-confidence* tripped by `858a40e4f`, working…") so a long run is visible live, with the verdict post replacing the placeholder when it settles. Posts carry refs to the firing fact, the trip's session, and — for staged outcomes — the dash, so the existing ref-resolve machinery makes every post clickable through to the evidence.

**"It has work for you" is told three ways, one mechanism:** the `staged` outcome posts to the Overview ("staged a fix on `wire-ci-confidence-858a40e` — 2 commits, join when ready," dash ref clickable into the Join sheet), lights the staged badge on the Wires card, and surfaces the dash in the ordinary dash lists. No new notification channel; three existing surfaces reading one outcome field.

## Deck surface

**A Wires sidebar card**, following the Jots precedent — wires are machine-global ambient state, the shape the sidebar taxonomy exists for. Rows: wire name, armed/paused toggle, a live running indicator while a trip is in flight, last-trip status glyph, and a **staged badge** when a wire has an unjoined dash waiting.

**No new card kind for history.** The Wires card goes two-level, like the pane-first Cards section: wire list → wire detail, and the detail is the trip log. From a trip row, two hops outward through existing surfaces: the session ref adopts onto a Session card, the dash ref opens the Join sheet. A wire-history card as a session-card variation would duplicate what adoption already does; composition covers it.

**Creation is conversational first, form never (initially).** A wire is mostly prose — the trigger predicate is the only structured part; the brief is exactly the thing you'd rather tell an AI than fill into fields. The substrate is `tugutil wire lay`; the authoring path is a tugplug skill (`/wire`) that knows the wire doctrine: type `/wire watch for tugedit failures and diagnose them`, and the session's AI authors the trigger, scope, brief, and model, lays it, and reports the receipt. This matches the composer-routes world and ships in the plugin, so wire authoring works identically from a standalone Tug.app. The Wires card gets the small knobs — pause/resume, model picker, post policy — not a full authoring form. Editing a brief is the same conversation: `/wire edit ci-confidence …`.

## CLI surface

```
tugutil wire lay <name> [--on <trigger>] [--scope <path>] [--probe <cmd>] [--brief <text|file>] [--model <m>] [--permissions <mode>]
tugutil wire list | edit | rm | pause | resume
tugutil wire log <name>          # the trip log, full workings
tugutil wire trip <name>         # fire it by hand — how you test a wire without waiting for lightning
```

`wire trip` matters more than it looks: a wire you can't fire deliberately is a wire you can't debug.

## Groundwork: `edit_failed` becomes a first-class fact

Today a failed `tugutil file edit` evaporates into stderr — exit class 2/3/4, no ledger, no fact. Triggers are predicates over facts; anything worth tripping on must leave a fact. The emission path needs care: facts are written by tugcast (`SessionLedger` / `facts_library`), and `tugutil` is a foreign process that must not open that ledger. The clean path is the one receipts already use: the edit verb emits a machine-readable failure block on stderr — a `TUG-EDIT-ERROR` marker carrying the program text, the per-op resolution report, and the exit class — and the same tugcast attribution layer that scans `TUG-FILE-RECEIPT` out of tool results parses it into the `edit_failed` fact. Symmetric with success receipts, works from every route ($ shell, agent Bash, terminal), and keeps the ledger-write discipline intact. Bonus: the marker block is also the evidence bundle the diagnosing wire wants — one format, two consumers.

This precedes everything else, and sets the precedent: anything worth tripping on should be worth a fact.

## Open edges

- **Trigger predicate syntax.** Predicates over facts (kind, fields, command patterns) plus a few feed-level events (`GIT_HEAD`). How expressive, and in what notation?
- **Cooldown defaults**, and whether cooldown is per-wire only or also per-event-key.
- **The `/wire` skill's exact shape** — what doctrine it carries, and how it validates a trigger before laying it (likely by dry-running the predicate against recent facts).
- **The cardless spawn entry point** — the supervisor addition beside `spawn_session`, and what session lifecycle (rename, close, GC) looks like for wire-owned sessions nobody adopted.
- **Concurrency ceiling** across all wires (machine-wide), not just the per-wire in-flight guard.
