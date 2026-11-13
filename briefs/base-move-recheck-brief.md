# Show the engine's re-audit on the card, from the moment the base moves

**Purpose:** When a landing on the base makes a finished arc re-audit, the card holding that arc says almost nothing: no start, no progress, no clock, no ending. The work is real and takes minutes, and the user is left looking at a card that reads `Finished`.

---

## Purpose {#purpose}

The user's report, on `masthead-rename` held by the card `burly-brook`, minutes after `workspace-switch-responsive-correct` joined `main`:

> When an arc re-audits after another change makes it do so, the feedback in the re-auditing session ***sucks***. […] We need to do *way* better.

What the card showed: a caution toast reading "masthead-rename's audit is stale — re-stamping it onto the moved base", an ARC cell reading `Finished`, and an idle composer. Nothing in the transcript.

And, settling the shape:

> *Must* live in the transcript. I thought we did this before, but I guess not.

> Name the arc that triggered the re-audit. Why not? But we can't just sit there and look around like a doofus either. These re-audits must happen *right away*.

---

## Evidence {#evidence}

**[F01] The engine's answer to a base-only stale audit is three pieces of work with no turn.** `spawn_replay` and `finish_quiet` in `tugrust/crates/tugcast/src/feeds/base_motion.rs` replay the arc onto the moved base, run the project's verify (`tugarc_core::surfaces::verify_by`), and on a green fit write a fresh `audited` mark (`ops::restamp_audit`). A conflict, a red fit or a verify that could not run seats the audit stage on the bound card instead, or leaves the arc waiting for a card. **(verified, read from the code)**

**[F02] The work already starts at once; what takes the time is the verify.** `main` moved at 18:08:24 (`328e0551c`) and `tugtool arc show masthead-rename` dates all five replayed rounds 18:08:25–26. The wake is the GIT_HEAD signal, not a timer. The verify is then the `deck` surface's five checks from `.tugtool/config.toml`: `tsc`, `vite build`, `just test-ts` (about two minutes by its own comment), `just app-test-changed {paths}` (serialized behind the machine-wide app-test gate) and `just lint-audit`. Its horizon is `restamp_horizon_secs`, thirty minutes unless declared. **(verified for the start time and the check list; the verify's wall time on this run was not measured)**

**[F03] The verify's progress exists and the engine discards it.** `verify_by` (`tugrust/crates/tugarc-core/src/surfaces.rs`) passes `VerifyHooks` whose `wrap`, `verdict` and `watch` do nothing. `VerifyEvent` already carries `Planned`, `Started` and `Finished` per surface, and `run_verify` in `tugrust/crates/tugtool/src/arc.rs` uses the same hooks to draw a row per surface on its Bash block, with the runner wrapper (`verify_wrapper`) and the test-ledger verdict reader (`verify_verdicts`) supplying counts. **(verified)**

**[F04] The toast in the report is a refusal, not a status.** The register line reaches the Session card only through `joinModeOpenRefusal`: `enterChanges` and the `/arc-join` handler in `tugdeck/src/components/tugways/cards/session-card.tsx`, and `refusalSentence` in `tugdeck/src/lib/join-mode-controller.ts`. Each fires on a press. A card nobody presses is never told the work began. The Arcs card row and the Changes shade's arc lane show the same line, but neither is the card's transcript. **(verified)**

**[F05] The ARC cell reads `Finished` throughout.** In `session-card-telemetry-renderers.tsx` the cell takes the register's word only when `joinReady` holds; a stale audit falls through to `arcCellWord`, whose word for the phase is `Finished` (`tugdeck/src/lib/arc-track-model.ts`). **(verified)**

**[F06] The wire carries a clock and a failure reason that no face renders.** `ArcRestamp` (`tugrust/crates/tugcast-core/src/types.rs`) has `running_since`, `deadline` and `seated_why`. In `tugdeck/src` the first is read as a boolean (`restampRunning`), the second only by `restampRefusal` in `tugdeck/src/lib/arc-verbs.ts`, and `seated_why` is parsed in `changeset-types.ts` and read by nothing. There is no phase, no surface list and no count on the wire at all. **(verified)**

**[F07] The transcript records none of it.** The quiet path spends no turn by design, and the only way the engine speaks into a session today is `inject.send`, which injects a turn (the mid-plan replay notice). A wheel stage gets a labelled divider on the card's scroll; the engine's replay, verify and mark get nothing at the start and nothing at the end. **(verified)**

**[F08] The engine waits in silence when it cannot start.** `decide_for_arc` skips a stale done arc for `session-busy` (the bound session is mid-turn or holds a background job), `dirty-worktree` and `join-journal`. Each is a `debug!` line and nothing else, so an arc parked behind one of them reads exactly like an arc nobody is answering. **(verified)**

**[F09] The landing that moved the base names its arc.** A join's squash commit carries a `Tug-Arc: tugarc/<name> onto <base>` trailer (asserted in `tugrust/crates/tugarc-core/src/ops/join.rs`; present on `328e0551c`). A plain commit on the base has no such trailer. **(verified)**

**[F10] "Re-stamp" is the mechanism's name, and it is in every user-facing sentence.** The register line (`arc-join-register.ts`), the Re-audit refusal (`arc-verbs.ts`) and `tuglaws/arc-lifecycle.md` all say "re-stamping it onto the moved base" or "a quiet re-stamp is running". The user calls the whole thing a re-audit. **(verified)**

---

## Decisions {#decisions}

**[B01] The engine's re-audit is shown in the transcript of the card that holds the arc.** The user's call, and not negotiable: it must live in the transcript. It appears there when the work starts, with no press, and it stays in the scroll afterwards as the record of what the engine did. The ARC cell and its popover are the glance; they are never the only surface.

**[B02] The transcript entry is a live block, not a line.** It shows the phase (replaying, verifying, marking), one row per surface the verify planned with its status as each starts and lands, test counts where the runner recorded them, the elapsed time, and when the horizon falls. It should read as the same kind of object as a `tugtool arc verify` block, because it is the same run ([F03]).

**[B03] It spends no turn.** The quiet path exists so a join on the base costs no turn per waiting arc. The transcript entry is the engine's own, not an injected prompt and not a model reply, and nothing about showing it wakes the model.

**[B04] The headline names what moved the base.** The base's new tip sha always; and the arc that landed it, read from the `Tug-Arc` trailer, when the tip is a join ([F09]). A plain commit is named by its sha and subject.

**[B05] The entry appears the moment the base moves, and a wait says why.** The work already starts within a second ([F02]); the entry must be on the card in that same beat. When the engine cannot start — the session is busy, the worktree is dirty, a join is in flight ([F08]) — the card says so and names what it is waiting on, and the entry turns live when the wait ends. No state of a stale audit is silent. This is my reading of "must happen right away"; if the user also wants the verify itself made shorter, that is the open question below.

**[B06] The quiet job publishes its progress on the arc's feed entry.** It runs the verify with real hooks — the watch, and the wrapper and verdict reader `tugtool arc verify` already uses — and the wire gains the phase, the surface rows and what triggered the run, beside the clock it already carries. Every face reads that one fact, so the transcript, the cell, the Arcs row and the lane cannot disagree.

**[B07] The ARC cell stops reading `Finished` while the work runs or waits.** It takes the register's word with a live dot, the way it already does for a join offer, and the popover carries the same rows as the transcript entry.

**[B08] The ending is said on the card.** Green: the entry closes on a verdict naming the base tip it now stands on, and the join offer opens as it does after a first audit. Not green: the entry closes on `seated_why` — the conflicting paths, or the check that went red and its first failure — before the re-audit stage's divider.

**[B09] The faces call it a re-audit, in plain words.** "Re-stamp" stays in the code and leaves every user-facing string: the register line, the Arcs row, the lane, the refusal toast and the Re-audit button's refusal. The sentences say what is being checked, against what, and when it ends. `tuglaws/arc-lifecycle.md` quotes the current strings and moves with them.

**[B10] The refusal toast stays a refusal.** A press on a join that is not on offer still answers with the register's sentence. It is no longer the first the user hears of the work.

---

## Open Questions {#open-questions}

- **How a no-turn entry reaches the transcript and survives a reload.** Stage dividers and injected-turn openers are the two existing ways tugcast writes into a card's scroll; neither is a live block that updates and then persists. The arc has to establish which of them the entry extends, and how it is replayed when the card reloads or the session resumes mid-run.
- **An arc with no card.** The quiet path runs bound or not. With no card there is no transcript to write in; the Arcs row is the only face. Whether the entry is written retroactively when a card later binds, or the row alone carries it, is undecided.
- **Whether the verify itself should be shorter.** The start is already immediate; the minutes are `just test-ts` and `just app-test-changed` behind the app-test gate. Trimming the fit a re-audit runs is a different change with a real cost (it is what catches a red `main`), and nothing here decides it.

---

## Non-goals {#non-goals}

- **Changing what the engine decides.** When it re-stamps, when it seats the audit, the horizon and the Re-audit door's refusal all stand. This is about what is shown.
- **Spending a turn to narrate.** Rejected by [B03]: injecting a notice turn per waiting arc is the cost the quiet path was built to avoid.
- **Cell and popover only.** Offered as the cheaper alternative and rejected by the user: it leaves no record in the scroll.
- **A toast at the start.** A toast is gone in seconds and the work runs for minutes.

---

## Exit {#exit}

**An arc.** The order the work wants:

1. The engine runs its verify with real hooks and publishes phase, surface rows, counts and the trigger (sha, and arc from the `Tug-Arc` trailer) on the arc's feed entry; the deck's wire type and guard follow.
2. The waits ([F08]) are published the same way, so a parked arc has a reason on the wire.
3. The transcript entry on the bound card: appears at the base move, updates live, closes on its verdict, persists across reload — settling the first open question.
4. The ARC cell and popover read the same fact.
5. The sentences change ([B09]), with the register tests, the Arcs row, the lane and `tuglaws/arc-lifecycle.md`.
6. An app-test that moves a base under a finished arc and reads the card's transcript from start to verdict, without a press.
