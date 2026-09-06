# The seat an arc names is a seat the arc made

**Purpose:** The `arc-unification` join removed `tugtool arc create` from the implement stage's setup and no machine took its place, so every arc's first implement stage now opens on a `where` line naming a worktree that does not exist. The stage stops, the wheel reads a quiet turn, and the arc dies of a promise.

---

## Purpose {#purpose}

The `arc-never-stops` arc reached its implement stage on 2026-09-04 at 15:05 UTC and the stage reported:

> I can't walk a step: the arc the `where` line names doesn't exist as an arc. `tugtool arc list` returns an empty list; `tugtool arc status arc-never-stops` → `Arc not found`. The worktree in the `where` line, `.tug/worktrees/arc-never-stops`, does not exist. […] Implementing anyway would mean working on `main` — the one working root the doctrine forbids — so I've stopped instead of improvising a substitute.

The user's question: "We actually need this `tugtool arc create` back in the skill, right? It seems like a horrid bug that it got removed, right?" Both yes. The removal was one half of a decision whose other half — the runner making the seat it names — was never built. This brief settles both halves so the `where` line is a fact before it is written, and so a stage that ever finds it false stops the arc with a receipt rather than with silence.

---

## Evidence {#evidence}

**[F01] The join removed the one act that made a worktree.** Commit `3b80a6899` deleted from `tugplug/skills/arc-implement/SKILL.md` §1 the line `tugtool arc create <name> --description "<one line>" --json` with its "idempotent — returns the existing arc" sentence, and from `arc-audit/SKILL.md` §1 the line `tugtool arc create <name> --json`. The replacement §1.2 reads "The worktree is the `where` line's, already hydrated and already yours. Whatever the project declared in `[tugtool.arc].post_create` ran when the arc was created" — a sentence about a creation nothing performs. **(verified in the diff)**

**[F02] Nothing else creates the git side of an arc.** `/arc-plan` says of itself "never creates a worktree" (`arc-plan/SKILL.md:26`); `/arc` says "No worktree, no commits" (`arc/SKILL.md:153`); `tugtool arc run` calls `open_arc`, which appends `arc-start`/`arc-kind` and posts `arc_run` to bind, and touches git nowhere (`tugtool/src/arc.rs:1247-1276`, `1404-1440`); the runner's implement dispatch composes the `where` line from `tugarc_core::ops::worktree_path(project, name)`, a path computation, with no existence check (`arc_runner.rs` ~1100). The only creator is `tugarc_core::ops::create_in` (`ops.rs:1160`), reached solely through `tugtool arc create`. **(verified)**

**[F03] The `where` line is composed after a check that cannot see the seat.** The dispatch runs `tugarc_core::doctor::doctor` before any stage prompt (`arc_runner.rs:1270-1300`) and stops on its findings. The doctor compares four records — the ledger table, the arc log's declarations, the sqlite binding, and the arc record — and none is the branch or the worktree. On this arc it printed "The records agree." while `arc status` said "Arc not found". **(verified: `tugtool arc doctor arc-never-stops` vs `tugtool arc status arc-never-stops`)**

**[F04] The removal was half of a decision.** `notes/arc-experience-brief.md` [B05]: "A stage is handed its coordinates and reads them; it never derives them … from records the runner already holds (the arc record, *the seat it just made*, `plan status`)." The seat was assumed made. The arc-unification plan's Step 6 built the clause and the doctor check; nothing in it built the seat, and the audit read the code against a plan that never promised one. **(verified in the brief and the arc's task list)**

**[F05] The stage's refusal was correct, and the arc died of it anyway.** `arc-implement` §0 says "With no `where` line above, stop and say so"; §1 gives no instruction for a `where` line that is false. The stage ended its turn in prose. The runner then read one quiet turn (`arc.tick … quiet_turns=1 action=none` from 15:08 on) and, absent any other motion, would stop the arc as `stalled` at the clock's thirty minutes — a receipt that says "it went silent", which is the opposite of what happened. **(verified in the tugcast log)**

**[F06] `arc create` also recorded the working session, and audit lost that too.** `run_create` calls `claim_arc` after `ops::create`, which resolves the calling session and binds it to the arc when it is not already (`tugtool/src/arc.rs:160-185`, `1980-2010`). The dispatch's binding now stands in for the claim on the implement stage; the audit stage, which used `arc create` for the claim alone, now claims nothing. Whether anything downstream misses it is unverified; the join offer reads the binding the dispatch wrote, so probably not. **(the loss is verified; its consequence is not)**

**[F07] The line and the stage speak two id vocabularies.** `where_clause` is handed `arc.session`, the card's tug session id (`arc_runner.rs` ~1102). The stage compared it to the id the `arc-stage` line names, which is claude's session id, and reported "the bound session is `eba13bfe-…`; this session is `d681a9ff-…`" as a second problem. The shell holds the tug session id as `TUG_SESSION_ID` (`tugcode/src/session.ts:214`); the skill never says which id to read. **(verified)**

**[F08] Nothing pinned the seat.** `just test-standalone` builds `tugtool` and runs `tugplug/__tests__/standalone.test.ts`, which does not name `arc create` or the `where` line; the app-test `arc-fixture.ts` creates arcs by calling `tugtool arc create` itself, so every arc-facing app-test starts past the hole. No runner test dispatches an implement stage on an arc with no worktree. **(verified by grep)**

**[F09] What today's unstick is.** Typing `tugtool arc create <name> --json` into the seated stage, then the wheel's ask again, repairs one arc. Every arc opened before this lands needs it once, at its first implement stage. **(verified on `arc-never-stops`)**

---

## Decisions {#decisions}

**[B01] The dispatch makes the seat before it writes the line that names it.** The implement dispatch — and, idempotently, the audit dispatch — calls `tugarc_core::ops::create_in(project, name, None, false, None)` inside its blocking pass, before `opening_prompt` composes the `where` clause, and the clause is written from the outcome's `worktree` path rather than from `worktree_path()`. `create_in` is already idempotent on a present branch and worktree and already runs `[tugtool.arc].post_create`, so a second dispatch of the same stage costs nothing. A creation that fails stops the arc with a new reason, `ArcStopReason::SeatUnavailable`, whose sentence is "its worktree could not be made" and whose note carries `create_in`'s own error; the vocabulary is closed and the receipt formatter is exhaustive, so the reason is added in `tugarc-core` and the doctrine's table at once. Devise and review make nothing: they write documents at `.tug/arcs/<name>/`, which is not in the worktree, and a seat made at devise would sit empty through two stages that never enter it.

**[B02] The doctor's fifth record is the seat.** `tugarc_core::doctor` gains a finding, `seat-missing`, raised when the record says the arc is past devise and either the branch or the worktree is absent, or the worktree is not on the branch; its repair is `create_in`, and `--repair` takes it. `arc doctor` on a name with no arc record says "no arc named `<name>`" and exits 1 rather than "The records agree." The dispatch's existing filter passes `seat-missing` through as a stop, which is what makes [B01]'s failure mode and a worktree deleted by hand read the same way.

**[B03] The skill keeps the idempotent `arc create` as the fallback, worded as one.** `arc-implement` §1.2 and `arc-audit` §1 regain the verb in this shape: *the worktree in the `where` line was made by the dispatch; if it is not a directory, run `tugtool arc create <name> --json`, which is idempotent, capture `worktree` from the response, and say in one sentence that the dispatch had not made it.* A stage that finds the line true runs nothing. The belt exists because the plugin ships inside `Tug.app` beside the tugcast that composes the line, and the standalone contract says the AI must be able to drive Tug from the bundle alone; a stage that can repair a missing seat in one idempotent verb is cheaper than an arc that stops for it.

**[B04] A stage that finds its coordinates false stops the arc with a receipt, never with a turn ending in prose.** Every "stop and say so" in the stage skills routes through `tugtool arc ask <name> "<sentence>"`, which writes the sentence as the arc's last note and stops it as `needs a decision` with a Resume on the receipt. The skill's §0 gains the second case beside "no `where` line": *a `where` line whose worktree is not a directory after [B03]'s fallback.* This is the one path by which a stage's refusal becomes a stop the user sees in seconds instead of a stall they see in half an hour, and it is consistent with the `arc-never-stops` brief's rule that a stop recording a person's decision is never reversed by the machine.

**[B05] The `where` line names the card in the vocabulary the shell holds.** The clause reads `card <TUG_SESSION_ID>` and the skill says so: *the id is the one `printenv TUG_SESSION_ID` prints; claude's own session id never appears in a stage-facing line.* No comparison is asked of the stage; the line is what the dispatch verified.

**[B06] The seat is pinned at three layers.** A runner unit test dispatches an implement stage on a planned arc in a temporary repository with no branch and no worktree and asserts the worktree exists and the `where` line names it; a second asserts a failing `create_in` stops as `SeatUnavailable` with a receipt. A doctor unit test asserts `seat-missing` on a deleted worktree and its repair. `tugplug/__tests__/standalone.test.ts` asserts that `arc-implement` and `arc-audit` name `tugtool arc create` and that the door skills do not. The app-test fixture stops calling `arc create` for a wheel-driven arc, so at least one app-test opens an arc through `tugtool arc run --plan` and reaches the implement prompt with the worktree made by the dispatch.

**[B07] The doctrine says who makes the seat.** `arc-lifecycle.md` gains one paragraph under the wheel: *the dispatch makes the worktree before it names it, the doctor reads it as a record, and a stage repairs it only as a fallback it says out loud.* `arc-work-doctrine.md`'s one-working-root rule gains the sentence that the root is made by the machine and verified before the line that names it. The stop table gains the `seat unavailable` row.

---

## Open Questions {#open-questions}

- **Does anything read the audit stage's lost claim?** [F06] says the audit session is no longer bound by `arc create`. The join offer reads the dispatch's binding, so the answer is probably no; the plan's step touching `arc-audit` should read `join_pilot` and `bound_sessions_for` and say so in a sentence rather than assume it.

---

## Non-goals {#non-goals}

- **Not restoring the whole of the removed §0.** The four-probe preflight was removed for a good reason and the dispatch's doctor check is the right home; this brief adds the seat to what that check sees, it does not move the check back.
- **Not making devise or review create a worktree.** They never enter it.
- **Not changing `create_in`'s behaviour.** Carry stays off and the base stays the detected default branch on a dispatch, exactly as `tugtool arc create <name>` with no flags.
- **Not a dialog.** A stage that cannot find its seat asks through `arc ask`, which is the stop the doctrine already has for a question that is the user's.

---

## Exit {#exit}

**A plan, through a plain `/arc`**, after `arc-never-stops` lands: that arc is rewriting the same dispatch path, and this one adds a call to it. Every decision here is made and small; the parts order themselves — the reason and the doctor finding in `tugarc-core`, the dispatch call, the two skills, the tests, the doctrine. Until it lands, every arc's first implement stage needs `tugtool arc create <name> --json` typed into it once ([F09]).
