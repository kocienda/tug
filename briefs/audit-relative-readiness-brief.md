<!-- brief-skeleton v1 -->

# Audit-relative readiness: a stale audit re-seats the Wheel instead of resolving in the shade

**Purpose:** Two arcs finish together; one joins; the other must now be fitted against a main it was never audited on. Today that fitting happens in the Changes shade's resolve ladder, a UI too limited to do or explain the work. The missing piece is that an audit is relative to a base tip and an arc head, and an arc whose audit has gone stale should go back into its audit stage on the Wheel, in the transcript, with the join offer withdrawn until it is current again.

---

## Purpose {#purpose}

The user, 2026-10-29:

> If I implement two arcs at the same time, ^ra and ^rb, and let both run to the completion of their implementations, obviously, I need to join one first. Let's say it's ^ra. Then we need to resolve ^rb against the new main that includes ^ra. However, we've now said that we need to do all this resolution during the *Auditing* phase. There's a problem here: ^rb has finished its *Auditing* phase, eh? So, what if we said that an arc can *go backwards* back into its Auditing phase. I think this should have the effect of *withdrawing* its *Ready to join* state, pull down the UI in the Changes shade which displays this *ready-to-join-ness*, and *return the control to the Wheel* so it can run through any and all work that needs to be done, using the regular transcript UI to do so. This would *relieve a huge amount of burden* from the (not very good) arc/resolution UI we have in the Changes shade, since in my honest evaluation, such a UI is too limited to accomplish and communicate all the work that potentially might need to be done.

On re-audits: "Ideally, there would be a phase to these re-audits to give an honest assessment of how much work actually needs to be done. We don't need to take up extra time and tokens. After all, *it's a re-audit*."

---

## Evidence {#evidence}

**[F01] The audit stage already owns everything a resolution needs.** The audit skill (`tugplug/skills/arc-audit/SKILL.md:100–126`) replays the arc onto the live base, resolves a `Conflicted` replay in the worktree as ordinary rounds, runs `tugtool arc verify` over what the replay moved, rewrites the draft as its author of record, and marks `audited`. That is the resolve ladder's whole job, done by a model with the tree and the tests in hand. **(verified)**

**[F02] The doctrine already says a conflict is a turn, not a rung, but the turn runs outside the Wheel.** `tugplug/doctrine/arc-work-doctrine.md:54` and `base_motion.rs:227–260, 855–875` compose a conflict message and inject it into the arc's idle bound session as an ordinary submission. That turn has no stage, no cold read, no hand-back, and no receipt; the arc stays `audited` and join-ready throughout, with the shade's offer up and the resolve ladder standing as the "fallback" for the same work. **(verified)**

**[F03] `audited` is a latch nothing clears.** `ArcDeclarations::latest` in `tugrust/crates/tugarc-core/src/log.rs:698–699` moves only on `built`, `audited` and step events; `join_ready` (`log.rs:821–853`) reads the latch and never the base tip or the arc head. A base move or a new round after the audit leaves the arc ready. **(verified)**

**[F04] A done arc has no door back into the Wheel.** `finish` in `arc_runner.rs:3665–3745` appends `arc-done`, hands the deck's model back, and removes the arc's entry with the comment "the arc is done, not resumable". `tugtool arc run` resumes a *stopped* arc at its stopped stage; a done one is refused. **(verified)**

**[F05] The verify receipt already carries what an audit was relative to.** `VerifyReport` in `surfaces.rs:649–657` holds `base`, `head`, the verdict and the surfaces checked, and `tugtool arc mark audited` is appended beside it. Nothing reads the pair back. **(verified)**

**[F06] The shade's resolve machinery is the cost the user is naming.** The join board's candidate, run, stuck line, question and report (`join_board.rs:255–310`), the pilot's auto-resolve (`join_pilot.rs`), the deck's resolve on join-mode entry (`join-mode-controller.ts` `ensureCandidate`) and the fold's resolve ledger (`session-changes-resolve-ledger.tsx`) exist to fit an arc to a moved base at join time, in a surface that can show a sentence and a file list and nothing else. `briefs/arc-join-shade-legibility-brief.md` [F04]–[F07] records that surface failing to present, to explain itself, and re-running four-minute checks on each glance. **(verified)**

**[F07] The base-motion engine already wakes on the edges a re-audit needs.** `arc-work-doctrine.md:39`: the base HEAD moving, a workspace opening, and a turn ending. A session bind is not yet one of them. **(verified)**

---

## Decisions {#decisions}

**[B01] An audit records the base sha and the arc head it verified against.** The `audited` mark carries both, taken from the verify receipt ([F05]). An audit that cannot say what it was relative to is not one this rule can read.

**[B02] Ready is derived: audited, and neither tip has moved since.** `join_ready` compares the audited pair to the current base tip and arc head. Either moving makes the arc **audit-stale**: not ready, offer withdrawn, join refused. This replaces the latch ([F03]) with a fact, the same move D147 made for readiness. Declaring staleness by hand is not needed and not offered; "going backwards" is what the derivation does.

**[B03] A new round after the audit un-audits.** A round is a head move, so [B02] covers it with no special case. The draft and the verify are both about bytes that changed; the re-audit's triage ([B06]) is what keeps a one-line fix from costing a full audit.

**[B04] A stale audit re-seats the audit stage on the Wheel.** The arc's record opens a new generation at audit, through the same resume path a stopped arc takes ([F04] is lifted: done is resumable at audit, and only at audit). The stage walks its own flow in the transcript the user is already reading: triage, replay, resolve, verify, draft, mark. The base-motion engine's conflict turn ([F02]) is retired in favour of this seat; the Wheel is the only thing that runs a resolution. A **Re-audit** button in the fold takes the same door explicitly.

**[B05] The machine keeps the quiet case.** When the replay is `Current` or clean and `tugtool arc verify` over what moved is green, the engine replays, verifies, and re-stamps the audit's base tip with no turn spent, exactly as it replays silently today. Only a `Conflicted` replay, a red verify, or an arc-side head move seats the stage. Without this, every join to main would cost one audit turn per ready arc, which is the one real risk in the idea.

**[B06] A re-audit opens with a triage rung sized by what moved, and says which size it chose.** The stage diffs the audited head against the current head and the audited base against the current base, names the paths, and declares one of three sizes before any work: **re-stamp** (nothing moved on the arc side, replay clean, verify green: mark and stop); **fold** (rounds landed, replay clean: verify only the surfaces those paths resolve to, amend the draft for the rounds, mark); **full, scoped** (a conflict or a red verify: the audit flow over the conflicting and red paths, carrying the original audit's findings rather than re-deriving them). The transcript line reads like "re-audit: one round, two surfaces, draft amended". A re-audit that cold-reads the whole arc again is the waste the user named.

**[B07] An arc with no idle bound card waits for the bind, and the bind is the wake.** The lane and the fold read "audit stale, waiting for a card"; the offer stays down. A session binding to the arc is added to the engine's wake edges ([F07]). Nothing is lost by waiting: nothing can join until the re-audit runs. `tugtool arc run <name>` from any card is the explicit door.

**[B08] The join loses its ladder.** When an arc is ready by [B02], the fit was verified against this exact base, so the join is squash and land: no candidate, no resolve run, no stuck line, no app-test at press time. The board's candidate, run, stuck and question fields, the pilot's auto-resolve, the deck's `ensureCandidate`, and the fold's resolve ledger go ([F06]). The join fold shrinks to the offer, the draft, and three waiting states: stale and re-auditing (with the card it is on), stale and waiting for a card, and stopped with a question.

**[B09] This brief retires part of `briefs/arc-join-shade-legibility-brief.md`.** Its [B02] (structured stuck line), [B04]–[B05] (reveal keyed on an attention fact), [B06] (base-red subtraction at the join check) and [B07] (no automatic resolve) describe machinery [B08] removes; they stand only until this lands and are not to be extended. Its [B01] (dialog button width) and [B03] (landing scale) are unaffected.

---

## Non-goals {#non-goals}

- **A hand-declared "back to audit" state.** Considered and folded into [B02]: a latch the user flips is the latch problem again. Staleness is derived; the button in [B04] seats the stage, it does not declare a state.
- **Re-auditing every ready arc on every main move with a model turn.** Rejected by [B05]; the silent machine path is what makes the rule affordable.
- **Keeping the resolve ladder as a fallback for unbound arcs.** Rejected by [B07]: the fallback was the surface the user is retiring, and waiting for a card is the honest state.
- **Changing what the first audit does.** The audit skill's flow stands; this brief adds what it records ([B01]) and a triage rung for its re-entry ([B06]).

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land: the audited pair on the mark and the derived readiness ([B01], [B02]), which withdraws the offer on staleness before anything else changes; then the resume-at-audit door on the Wheel and the bind wake ([B04], [B07]); then the engine's silent re-stamp and the retirement of its conflict turn ([B05]); then the triage rung in the audit skill ([B06]); and last the removal of the ladder, the pilot, `ensureCandidate` and the resolve ledger, with the fold's three waiting states in their place ([B08]). The dialog and type fixes from the earlier brief can land at any point beside this.
