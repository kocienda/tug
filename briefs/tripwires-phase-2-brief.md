<!-- brief-skeleton v1 -->

# Tripwires phase 2: one ladder for the budgets, one noun for the feature

**Purpose:** Phase 2 of `briefs/tripwires-multi-phase-brief.md`. The parent asked for two things under one heading: fold the trip engine's scheduler into the supervisor's spawn budget, and make the schema and the code agree on the noun. The second is straightforwardly right and this brief carries it. The first is not implementable as written — the four things it names do four different jobs, only one of which is a budget — so this brief replaces the fold with the defect the fold was reaching for: a host at its session cap turns a tripwire firing into a `failed` row instead of a queued one.

---

## Purpose {#purpose}

The parent's Phase 2 reads:

> **Covers:** Fold claim, queue, supersede, and the concurrency ceiling into the supervisor's spawn budget [B02]. Rename `wires` and `wire_marks` with a registered migration and bump; purge `wire`, `dash`, `envelope`, `tier`, `post` from code, comments, and test prose [F08] [B03]; rewrite the stale module headers in `tripwire_session.rs` and `tripwire.rs`. Add a guard that fails on the retired words.
>
> **Done when:** the trip engine owns no ceiling or budget of its own, the schema and the code agree on the noun, and the guard is green.

The parent's [B02] states the principle the fold serves — "the trip engine stops reimplementing what the supervisor and arc runner already have" — and Phase 1 answered its first half by moving turn-end onto the supervisor's session entry and deleting every ceiling that could settle a live session. This brief answers the second half. It keeps [B02]'s principle and rejects one sentence of its mechanism, on the evidence below: three of the four named pieces are not budgets and have no budget to fold into, and the fourth guards a different resource, at a different scope, from a different process. What is really there is a seam between two budgets that already compose, and one place where they disagree in the user's face.

The vocabulary half is carried as the parent wrote it, with two shapes of exception the code forces and the parent could not have known about.

---

## Evidence {#evidence}

**[F01] The four things Phase 2 proposes to fold do four different jobs, and three of them are not budgets.** Read out of `consider` at `tugrust/crates/tugcast/src/feeds/tripwire.rs:796` and the ledger verbs it calls:

- **Claim** (`claim_trip`, `tripwire_ledger.rs:745`) is an `INSERT OR IGNORE` against `UNIQUE(wire_id, event_key)`. It is *cross-instance deduplication on a durable constraint* — what makes two tugcast instances that both see one landing produce one trip. It rations nothing and has no count in it.
- **Supersede** (`queue_trip`, `tripwire_ledger.rs:793`) marks every other queued trip of the same tripwire `superseded` and leaves it in the log. It is a *coalescing policy*: "a CI tripwire asked to verdict five commits in a storm wants the last one's verdict, not five worktrees." A budget refuses; it does not coalesce, and the supervisor has no queue to coalesce in.
- **Queue** is deferral with a drain (`drain_queue`, `tripwire.rs:335`). The supervisor's budget has no deferral at all — `cap_check_reason` returns a `ControlError::CapExceeded` and the spawn is over.
- **The ceiling** (`max_concurrent_trips`, default 2) is the only budget among them, and it is machine-wide and durable: `running_count` counts `running` rows across *every* instance sharing `tripwires.db`. **(verified)**

**[F02] The trip ceiling and the supervisor's budget guard different resources at different scopes, and the trip's session already spends both.** `AgentSupervisorConfig::max_concurrent_sessions` is 64, per-process, in-memory, and documented as a *memory* budget — "roughly 240 MB of private memory" per live session (`agent_supervisor.rs:1637-1652`). `DEFAULT_MAX_CONCURRENT_TRIPS` is 2, machine-wide, in SQLite, and documented as a *worktree* budget — "A commit storm must not fan out one arc worktree per commit" (`tripwire_ledger.rs:107`). `spawn_headless_session` runs the same `cap_check_reason` every card spawn runs, with the comment "The budget is not waived: a wire's session is a real subprocess and counts like every other" (`agent_supervisor.rs:5418`). So the two budgets do not sit beside each other ignoring one another; they already compose — the trip ceiling rations trips against each other and the host cap protects the machine. Deleting the trip ceiling in favour of the host cap would let a commit storm cut up to 64 arc worktrees, which is the thing the trip ceiling exists to prevent. **(verified)**

**[F03] When the host cap refuses a tripwire's spawn, the trip is recorded as `failed` rather than queued — the one place the two budgets genuinely disagree in the user's face.** `SupervisorTripwireSessions::run` maps the spawn error to `Err(format!("the tripwire's session could not be spawned: {e:?}"))`; `run_phase` turns that into `unresolved_headline(Err(..))`, which is `"the tripwire's session did not run: …"`, settled `failed` through `settle_if_running`. A `CapExceeded` is a *busy* condition — the host is full right now and will not be in a minute — and the trip log records it as a failure of the tripwire, next to the real ones. The queue that exists three lines earlier in `consider` is never consulted, because the ceiling check happens before the claim is run and the cap is only discovered inside the spawn. This is the concrete shape of the parent's [F05] "the two ceilings can disagree silently". **(verified — `tripwire_session.rs` `run`, `tripwire.rs` `run_phase`/`unresolved_headline`)**

**[F04] Nothing pins the two budgets' relation, and Phase 1's guard covers durations only.** Phase 1 added `every_remaining_duration_bounds_a_probe_an_orphan_or_a_poll`, which enumerates every `Duration` the two engine files declare and says what each bounds. There is no equivalent for the counts: `max_concurrent_trips` may be set through the `settings` table to any positive integer, including one far above `max_concurrent_sessions`, and nothing notices. **(verified — `tripwire.rs` tests, `max_concurrent_trips` at `tripwire_ledger.rs:1315`)**

**[F05] The table names are `wires` and `wire_marks`, and the code carries an argued decision against renaming them.** `tripwire_ledger.rs:118-120` reads: "The tables keep the short name the first schema gave them. A table is not a reading surface, and renaming one costs a migration on a ledger that already holds rows to buy nothing anybody sees." The parent's [B03] decides the opposite, explicitly and with the migration named. The comment predates the decision; [B03] is the user's call and supersedes it, and the comment is part of what this phase removes. **(verified)**

**[F06] The rename is internal: `wire_id` never reaches the deck or the HTTP surface.** `tugdeck/src/lib/tripwires-store.ts:64` already declares `readonly tripwire_id: number`, so the JSON the card reads is already spelled the new way and the server already translates. The purge touches no client contract. **(verified — grep for `wire_id` across `server.rs` and the deck returns nothing)**

**[F07] The retired words are concentrated and small, and Phase 1 already did one line of this phase's list.** Counts of `wire` / `dash` / `envelope` / `tier` in the tripwire surface: `tripwire_ledger.rs` 132/7/3/6, `tripwire.rs` 66/0/0/4, `tripwire_tree.rs` 8, `tripwire_dossier.rs` 5/3, `tripwire_predicate.rs` 5, `tugtool/src/tripwire.rs` 11/0/2/1, and one apiece in `tripwires-store.ts` and `tripwires-card.tsx`. `tripwire_session.rs` is already at zero — Phase 1's [B08] rewrote its module header, which is the "rewrite the stale module headers" item of Phase 2's list, already done. **(verified — per-file counts)**

**[F08] A flat retired-word guard would fail on correct code, in two distinct ways.** First, **the migrations and their compatibility readers must keep the old words**, because the old words are what is on disk in an old ledger: `ALTER TABLE wires DROP COLUMN tier` (`MIGRATE_V1_TO_V2`), `UPDATE trips SET swallow_reason = 'own-arc' WHERE swallow_reason = 'own-dash'` (`MIGRATE_V3_TO_V4` and `migrate_trips_arc_column`), the `dash`-column probe at `tripwire_ledger.rs:478`, and the dossier's `landing.get("dash")` fallback at `tripwire_dossier.rs:104` whose own comment says "A dossier written before the rename spells it `dash`". Second, **`post` and `wire` have live legitimate senses in this tree**: `tripwire.rs` uses the Overview's `post` noun eleven times (`OverviewPost`, `post_settled`, `record_overview_post`, and the `[P08]` test prose "never a post"), and the deck's `wire` means the protocol wire format across `protocol.ts`, `connection.ts` and `code-session-store`. The parent's Phase 2 listing of `post` among the retired words meant the deleted *post-policy knob*, not the Overview post. **(verified)**

---

## Decisions {#decisions}

**[B01] The trip engine keeps claim, queue, supersede, and its own ceiling; the fold named in the parent's Phase 2 is withdrawn.** [F01] and [F02] are the argument: three of the four are not budgets and have nothing in the supervisor to fold into, and the fourth guards worktrees machine-wide where the supervisor's guards memory per-process. A fold would delete a cross-instance dedup constraint, a coalescing policy, and a worktree bound, and would buy the engine nothing it does not already have — the trip's session has spent the host budget since the day it was written. The parent's [B02] principle is kept and is what the rest of this brief serves; what is withdrawn is one sentence of mechanism, written before the two budgets' scopes were read side by side. Revisit if a second tripwire ever makes the machine-wide ceiling bind in practice, which Phase 7 is where that would show.

**[B02] The two budgets become one ladder: the host cap is consulted where the trip ceiling is, and a refusal queues instead of failing.** This is the defect [F03] found and the honest whole of "one scheduler". `consider`'s ceiling check gains the host's answer beside the ledger's, so a trip that cannot be spawned right now takes the `queued` branch that already exists three lines away and is drained by the same sweep that drains a ceiling-queued trip. The supervisor grows the one read this needs — whether a spawn would be admitted, without performing one — and the tripwire engine asks it rather than discovering the answer inside a failed spawn. A `CapExceeded` escaping into `run_phase` after that is a race rather than the ordinary path, and it settles `queued` too, not `failed`: the trip did not fail, the host was full.

**[B03] A test pins that the trip ceiling never exceeds what the host will admit, and says why each budget exists.** [F04]'s gap, closed the way Phase 1 closed the durations one: a test that names both counts, states which resource each guards — worktrees machine-wide, memory per-process — and fails if the effective `max_concurrent_trips` could exceed `max_concurrent_sessions`. The settings row is clamped rather than trusted, for the reason `max_concurrent_trips` already falls back on a malformed value: a typo in a settings row must not let a commit storm outrun the host.

**[B04] `wires` becomes `tripwires`, `wire_marks` becomes `tripwire_marks`, and `wire_id` becomes `tripwire_id`, through a registered migration at schema v6.** The parent's [B03], carried. The migration is registered in `TRIPWIRE_MIGRATIONS` keyed from 5 and `TRIPWIRE_SCHEMA_VERSION` is bumped to 6 — never the DDL alone, which is both this ledger's own rule and the repository's. `ALTER TABLE … RENAME TO` is not idempotent, so the rename follows `migrate_trips_arc_column`'s precedent and probes the shape it finds rather than assuming the version stamp is honest: a pre-versioning ledger stamped 0 never enters the registered loop at all, and a crash between a batch's statements re-runs it. The comment at `tripwire_ledger.rs:118` arguing against the rename [F05] goes with it. No client contract moves [F06].

**[B05] `wire`, `dash`, `envelope`, and `tier` leave the tripwire surface's code and prose; `post` is not on the list.** [F08] is why: the Overview post is the live noun for what a tripwire genuinely does, and putting `post` on a retired-word list would either fail eleven correct lines or teach the guard to lie. The parent's Phase 2 line meant the deleted post-policy knob, which left with the simplification brief and is already gone from the schema — `the_retired_knobs_are_dropped` already pins `tier`, `post`, and `cooldown_secs` off the table.

**[B06] The guard is scoped to the tripwire surface and exempts the migrations, in the source, by name.** Not a repository-wide grep: `wire` is the deck's protocol noun in a dozen files that have nothing to do with tripwires [F08], and a guard that has to be silenced everywhere it is wrong is a guard nobody trusts. It reads the tripwire files' own bytes — the pattern Phase 1's duration guard established — and skips the regions where the old word is the thing on disk: the `MIGRATE_*` constants, `migrate_trips_arc_column`, the dossier's pre-rename fallback, and the fixtures that build an old ledger to migrate it. Those exemptions are named individually rather than by a wildcard, so adding one is a decision somebody makes on purpose.

---

## Open Questions {#open-questions}

- **Does the host's admission read need to be exact, or is a snapshot enough?** [B02] asks the supervisor whether a spawn would be admitted without performing one, and between that answer and the spawn a card may take the last slot. The answer is almost certainly that a snapshot is enough — the loser settles `queued` and is drained, which is the same outcome by a slower road — but whether the read should instead be a reservation is a question for whoever writes it, against the supervisor's own locking. It changes the shape of one function, not what the phase is.

---

## Non-goals {#non-goals}

- **Deleting `max_concurrent_trips`, `claim_trip`, `queue_trip`, or the supersede path.** Rejected by [B01] on the evidence of [F01] and [F02]. Recorded here so the fold does not have to be re-argued from the parent's table of contents.
- **Moving trips onto the arc runner.** The parent's [B01], unchanged and still out.
- **Renaming the `trips` table or the `settings` table.** `trips` is already the feature's own noun and `settings` is generic. Only the two tables spelling `wire` move [B04].
- **A repository-wide purge of the word `wire`.** The deck's protocol sense is correct and stays [F08] [B06].
- **Surfacing either budget as a user-facing knob.** The parent's [B06]: budgets are engineering guards, and Phase 2 makes them agree rather than exposing them.
- **Rewriting the module headers of `tripwire_session.rs` and `tripwire.rs`.** Phase 1 did it [F07].
- **Anything on the card, the feed, or the API.** Phases 4 and 5.

---

## Exit {#exit}

**An arc.** Two halves that do not interleave, and the behaviour change goes first so the rename sweeps over settled lines rather than the other way round: teach the supervisor to answer whether a spawn would be admitted and make `consider` queue on its refusal; pin the two budgets' relation with a test that says what each guards; rename the two tables and the column through a registered v6 migration; purge the retired words from the tripwire surface's code and prose; add the scoped guard with its migration exemptions named. Four to five steps.
