<!-- brief-skeleton v1 -->

# Tripwires phase 7: lay the second tripwire, let two of them meet a week of real landings, and fix what the log shows

**Purpose:** Phase 7 of `briefs/tripwires-multi-phase-brief.md`. Six phases rebuilt the engine, the card, the feed, the skill and the doctrine, and every one of them proved its half in tests. Nothing has yet run against the checkout's own landings: the one tripwire on this machine is still paused with the same fourteen rows it had when the parent brief was written, and the CI-confidence tripwire the original notes opened with has never been laid. This phase lays it, resumes the other, and reads what a week of use says — and the reading already begins here, because the trigger the second tripwire needs turns out to be blind to most of this repository's landings.

---

## Purpose {#purpose}

The parent's Phase 7 reads:

> **Covers:** Lay the CI-confidence tripwire the notes always wanted, with a probe, so the free green path is exercised alongside `edits`. Run both for several days of real landings and read the logs. Fix what the logs show.
>
> **Rests on:** everything above.
>
> **Done when:** a week of landings across two tripwires produces no `failed` row and the awaiting trips it raised were each worth reading.

And the notes' first line, `briefs/tripwire-notes.md:6`: "**Post-commit CI confidence.** After every commit on main, run `just ci` in a safe place and flag anything red, so a push to GitHub carries earned confidence."

Phase 6's [B10] kept a rule for this one: a behaviour the documents found *wrong* was written down rather than fixed, because nothing in a documentation arc would exercise the repair. This phase is where repairs are exercised — by the landings themselves.

---

## Evidence {#evidence}

**[F01] The trigger grammar is a fact and nothing else, and `commit` is the only kind every landing gesture could carry.** `Predicate` in `tugrust/crates/tugtool-core/src/tripwire_predicate.rs` has one variant, `Fact(FactTrigger)`, keyed on a `facts.kind` string; `tugtool tripwire lay --on` accepts only `fact:<kind>`. The kinds `FactKind::as_str` spells are `prompt`, the seven `session.*` kinds, `commit`, `shell`, `test_run` and `edit_failed`. A tripwire that means "after every commit on main" therefore has to be `--on fact:commit`. **(verified)**

**[F02] The `/commit` gesture writes a `commit` fact; an arc join writes none.** In `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`, the `/commit` path records `commit_fact(…)` keyed to the requesting session and then sends the `LandingEvent` carrying that same session as lineage, so the fact is the newest row past the tripwire's mark and a `fact:commit` predicate matches it. The join path around line 7619 reads the arc's bound sessions as lineage and sends its `LandingEvent`, and records no fact at all — the only production caller of `commit_fact` in tugcast is the `/commit` path. A `fact:commit` tripwire would swallow every join as `no-match`. **(verified)**

**[F03] Most of this repository's landings are joins.** `git log --since=7.days main` holds 140 commits, 81 of them `tugarc(…)` joins. A CI tripwire laid on `fact:commit` as the engine stands would have watched fewer than half of the week it is meant to prove itself on, and the half it missed is the half that carries whole arcs. **(verified)**

**[F04] `edits` is paused, and its log has not moved since the parent brief.** `tugtool tripwire log edits` shows the same fourteen rows the parent's [F01] counted: six `failed`, seven `swallowed`, and one `settled` that was the hand-fired `manual:` trip. Phase 1's [B07] proved the loop over the real ledger with a scripted runner and named the live landing "the user's follow-through". No landing-fired trip has yet completed on this machine. **(verified)**

**[F05] A probe runs in the landing's detached inspection tree, under `/bin/sh -c`, with tugcast's own environment.** `run_probe` in `tugrust/crates/tugcast/src/feeds/tripwire.rs` removes `TUG_SESSION_ID`, pins the pagers off, nulls stdin, and kills the child at `PROBE_TIMEOUT`, fifteen minutes; its comment names `just ci` as the motivating probe. `Tug.app` resolves the user's login-shell `PATH` (`ProcessManager.resolveShellPATH`) and hands it to its children, so `just`, `cargo` and `bun` resolve inside a probe. **(verified by reading; not yet run)**

**[F06] The inspection tree carries no build cache, and nothing gives it one.** `tripwire_tree.rs` cuts one `git worktree add --detach` per landing, shared by every tripwire that fires on it, and removes it when the last trip settles. No `CARGO_TARGET_DIR` is set anywhere under `tugrust/crates` or in `.cargo/config.toml`, so a probe that builds does so from cold, and the artifacts die with the tree. `just ci` is `lint test`: `cargo clippy --workspace --all-targets`, `cargo fmt --check`, `cargo nextest run` over the workspace, the TypeScript tests and `test-standalone`, which builds `tugtool` again. Whether that fits in fifteen minutes from a cold tree is **not verified**; the first trip's `probe_tail` will say, and a kill reads "the probe was still running after 15 minutes and was killed" rather than green.

**[F07] Two tripwires on one landing do not starve each other.** Marks are per `(tripwire_id, session_id)` in `tripwire_marks`, read through `fact_mark(conn, tripwire.id, session_id)` before `facts_for_session_after`, so `ci` advancing past a session's facts leaves `edits`'s mark where it was. The two share the landing's one tree. **(verified)**

**[F08] The ceilings that remain are three, and phase 2 named this phase as where the machine-wide one would bind.** `PROBE_TIMEOUT` at fifteen minutes, `ORPHANED_RUN_AGE` at ninety, and `max_concurrent_trips` defaulting to 2 from the ledger's `settings` table; no clock settles a session any more (phase 1's [B01], pinned by `a_turn_that_ends_after_an_hour_is_finished`). Phase 2's [B01] withdrew the fold into the supervisor's budget and said: "Revisit if a second tripwire ever makes the machine-wide ceiling bind in practice, which Phase 7 is where that would show." **(verified)**

**[F09] The end-to-end proof is the engine's own test over a scripted runner; no app-test fires a landing.** `the_running_engine_trips_on_a_landing_whose_lineage_carries_the_fact` drives a real landing through a real ledger with the runner phase 1's [F09] found. `at0492`, `at0568` and `at0572` pin the card, adoption and the feed. The parent's done-when — no `failed` row across a week — is a claim only real use can make, and the tests were never meant to make it. **(verified)**

---

## Decisions {#decisions}

**[B01] The engine hands every landing to the predicate as a `commit` fact, so `fact:commit` means "every landing gesture" for both kinds.** [F02] and [F03]: a join is the landing this feature was built for, and a trigger that cannot see one is not "after every commit on main". The `LandingEvent` already carries the sha, the branch and the kind; the engine composes a `FactEvent` of kind `commit` from it, with the sha, the message and the file list the receipt knows, and offers it to the predicate alongside the lineage's own facts. Keyed by the landing, it is seen exactly once per landing per tripwire, and the `/commit` gesture — which now yields both the session's durable fact and the landing's — still claims one trip, because the claim is on `(tripwire_id, event_key)` and not on how many facts matched. The alternative, writing a durable `commit` fact on the join path, does not fire the tripwire on its own: a join has no single session to key the fact to, and the lineage read is per session, so a fact with no session is a fact no lineage carries. That gap in the facts corpus is real and is a non-goal here.

**[B02] The second tripwire is `ci`: `--on fact:commit`, scoped to this checkout, branch `main`, probe `just ci`, and a brief written for the probe's residue.** The notes' own shape, with the probe carrying the whole of the green path: exit 0 spends nothing and writes one row. The brief is asked only when the probe is red, and it asks one question — which check went red, in which file, and whether the landing that just went in is what broke it — resolving `--quiet` when the failure is one the lineage's sessions already saw and fixed on the base, `--awaiting` with the failing command and the file when it is not. It carries `--author` only for a one-file repair whose test the probe already ran.

**[B03] `edits` is resumed as it stands.** Its brief was rewritten before phase 1 and reads correctly against the engine; the six `failed` rows are the twenty-minute ceiling phase 1 removed and instance restarts. Nothing about it needs re-laying, and resuming it is the whole of what the second half of "two tripwires" asks.

**[B04] The week is a week of the checkout's own landings, and the reading is written down.** The parent's done-when is a fact about real use, so the arc that lays the tripwires ends when they are laid, resumed and firing, and the week runs on the base after the join. What the week produced is read from `tugtool tripwire log <name> --json` and written as a short scorecard: every `failed` row with its cause, every `awaiting` row with a yes-or-no on whether it was worth reading, every `busy` or `queued` row as a mark against the ceiling. That document is the evidence for the repair arc.

**[B05] What the log shows is fixed by removing its cause, never by raising a number.** The parent's [B06] holds: a probe killed at fifteen minutes is a probe that builds from cold [F06], and the repair is a build cache the inspection tree can reach — a tripwire-owned target directory beside the trees, handed to the probe as `CARGO_TARGET_DIR` — or a lighter probe, not a longer ceiling. A `queued` row under two tripwires on one storm of landings is what phase 2 asked to see before revisiting the ceiling; two of them in a week is a finding, one is weather.

**[B06] A tripwire whose awaiting trips were not worth reading is repaired at its brief or its probe, and the log says which.** The parent's second criterion is about the brief's judgement rather than the engine's health. An awaiting headline that paraphrased the landing is a brief that asked the wrong question; one that was right but unwanted is a tripwire that should have had a probe or a narrower `--where`. Both are `tugtool tripwire edit`, and both are made from the scorecard rather than from a guess about how the week would go.

---

## Open Questions {#open-questions}

- **Where does a hand-typed `git commit` stand?** Carried from the parent unchanged. A CI tripwire is the first one a user will expect to fire on a commit they typed, and this phase is where that expectation meets the design. If the scorecard shows a red `main` that no tripwire saw because the commit came from a terminal, that is a new brief — the parent's rule — and not a quiet widening.
- **Is `just ci` the probe, or is it `just lint` with the tests behind a session?** Settled by the first cold run's `probe_tail` rather than argued here. The notes wanted `just ci`; if it fits the ceiling from cold with a build cache [B05], it stays. If it does not fit even warm, the probe is the fast half and the brief asks the session to run the slow half.

---

## Non-goals {#non-goals}

- **A durable `commit` fact for arc joins in the facts corpus.** The facts library and the Observer never learn a join landed; that is a gap in the Observer's record and wants its own brief. [B01] repairs the tripwire's view of a landing, not the corpus.
- **Raising `PROBE_TIMEOUT`, `ORPHANED_RUN_AGE`, or the concurrency ceiling.** [B05]; the parent's [B06].
- **A user-facing timeout knob.** Still not a product concept.
- **Firing on commits made outside Tug's landing gestures.** Kept out; the open question says when it becomes a brief.
- **A third tripwire.** Two is what the parent asked for and what the ceiling of two is sized to reveal.
- **Any card, feed, or skill change.** Phases 4 through 6 landed those; a repair the log demands of them is named in the scorecard and goes to its own arc.
- **A test that pretends to be the week.** The engine's e2e test already proves the loop [F09]; the week is proved by the week.

---

## Exit {#exit}

**Two arcs, with a week between them.** The first is small and ordered: [B01] first, because a `ci` tripwire laid before it is blind to eighty of this week's hundred and forty landings and the week would prove nothing; then `ci` is laid with `--preview` read back and `edits` is resumed, and the arc ends with both armed. Its checks are the engine's own tests in `tripwire.rs` for the landing-as-fact, and one hand-fired `tugtool tripwire trip ci` whose probe runs green from a cold tree or reports exactly why it did not. The week then runs on the base. The second arc opens on the scorecard [B04], and its brief is written from what the log actually shows — which is the only way the parent's "fix what the logs show" can be a brief rather than a prediction.
