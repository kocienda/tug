<!-- brief-skeleton v1 -->

# A stopped arc waits for its audit

**Purpose:** An arc stopped from the Arcs card between its last plan step and its audit was presented in the Session card as ready to join. Nothing had audited it. The join must not be offered on any wheel-driven arc until the audit has marked, whichever stage the stop names.

---

## Purpose {#purpose}

In the user's words: "I used the `stop` button in the Arcs card to stop an arc just as it finished its last plan step and before it began its audit. I need to change location, so I wanted to pick up the audit later. However, the session card *presented the arc to me as ready to join*, which it isn't, since the audit didn't happen yet. … Yes, the provisional pre-audit join message was written, but we need to wait for that to complete before we say the arc is ready to join."

Two things went wrong at once: the machine called the arc ready, and the surface acted on it — the Changes shade raised itself over the card with `Ready to join to main` and the implement stage's provisional draft in the composer, which is exactly what a finished arc looks like.

---

## Evidence {#evidence}

**[F01] The stop is stamped with the stage that was seated, and at the seam that is `implement`.** `arc_stop` records `record.current_stage()` — the last rotated stage — as the stop's stage (`tugrust/crates/tugcast/src/arc_api.rs:503`). Between the last `step-done` and the `arc-stage audit` line there is no audit on the record yet, so a stop pressed anywhere in that seam reads `(implement, "stopped by user")`, whether or not the wheel had already dispatched the audit. **(verified)**

**[F02] `WheelReading` treats every stop outside the audit as no wheel at all.** `WheelReading::of` returns `StoppedInAudit` only for a stop whose stage is `Audit`; a stop in any other stage is `Off` (`tugrust/crates/tugarc-core/src/log.rs:770`). Under `Off`, `join_ready` restores the three pre-wheel arms — `run_complete`, a `built`/`audited` mark, or a plan-less arc with rounds (`log.rs:786`) — and `run_complete` is true the moment the last declared step closes. So the stopped arc read `join_ready = true` and `derive_stage` said `ready`. **(verified)**

**[F03] Readiness is the only gate on everything downstream.** The join pilot reconciles and mints a candidate on `join_ready` alone (`tugrust/crates/tugcast/src/feeds/join_pilot.rs:97`); the standing offer is minted on `join_ready` alone (`tugrust/crates/tugcast/src/feeds/join_board.rs:370`), carrying `landing_message_preview` — the provisional draft; the session card enters the Changes route on a new `offer.arc_head` (`tugdeck/src/components/tugways/cards/session-card.tsx:3047`); and the register reads `Ready to join to <base>` because `ready` is in `JOINABLE_STAGES` and a candidate stands (`tugdeck/src/lib/arc-join-register.ts:441`). None of these readers needed to be wrong — they each did what `join_ready` told them. **(verified)**

**[F04] This is recorded doctrine, not drift.** The 2026-09-02 audit gate held the offer under a live wheel until `audited`, and made a stop the deliberate escape: `a_stopped_wheel_releases_the_offer_over_a_real_log` asserts that "a wheel that broke before the audit must not hold the landing hostage" (`tugrust/crates/tugarc-core/src/ops.rs:7806`). The stopped-audit brief (`briefs/arc-audit-face-brief.md` [B04]) later carved the audit stage out of that escape, and `tuglaws/arc-lifecycle.md:230` states the residue: "A stop in any earlier stage releases the offer as it always did, because the join never needed a wheel." The deck pins the same reading in `arc-join-register.test.ts:452` ("a stopped wheel does not hold the surface hostage") and `tug-arc-track.test.ts:57`. **(verified)**

**[F05] The provisional draft is, by its own skill's words, the audit's starting text.** The implement stage writes the join draft before the final declared step closes, and `arc-implement/SKILL.md:154` says it is provisional: "the audit stage is the author of record for the join message … the arming event is the audit's mark rather than this step's `done`." The audit rewrites it unconditionally (`arc-audit/SKILL.md:120`). The draft existing is not evidence the arc is finished; it is what made an unfinished arc look finished. **(verified)**

**[F06] A resume from this stop goes back through implement before it reaches the audit.** The predicate's resume arm rotates or continues the *stopped* stage — `implement` — with `steps = first_pending.zip(run_through)`, which is `None` once every step is closed (`tugrust/crates/tugcast/src/feeds/arc.rs:445`). The implement stage is re-seated with nothing to walk, ends a turn closing no step, and only on the following tick does `implement_action` see `run_complete` without an audit mark and rotate to the audit (`arc.rs:737`). Read from the code; not driven. **(verified by reading)**

**[F07] The join itself is not gated on readiness.** No reader of `join_ready` exists under `tugrust/crates/tugtool/src`; `/arc-join` lands an unaudited branch and its receipt says so, which is what the stopped-audit shape already relies on (`log.rs:706`). "Not ready" and "not joinable" are different facts, and only the first is at issue here. **(verified)**

**[F08] The deck does not yet receive `run_complete`.** `ArcDetail` carries it (`ops.rs:2251`) but `ChangesetEntry::Arc` does not; the wire carries `run_position`/`run_length` and `steps_done`/`steps_total` (`tugrust/crates/tugcast-core/src/types.rs:588`, `:1140`). **(verified)**

---

## Decisions {#decisions}

**[B01] A wheel-driven arc is never ready to join until its audit has marked, whatever stage its stop names.** Confirmed by the user in so many words: "Arcs must wait for their audit to be *complete* before they can become join-eligible." This applies to every arc with a record — planned and plain alike, because every arc under the wheel ends in an audit — and to every stop reason, a person's press included, because the fact is the same one [B04] of the stopped-audit brief already settled for the audit stage: the audit did not mark. The "hostage" worry that made a stop the escape [F04] is answered the way the stopped-audit case already answers it: the join stays *possible* through `/arc-join` [F07], it is simply never called *ready*. What would revisit this is an arc kind that has no audit stage, and none exists.

**[B02] `WheelReading` collapses to `Live | Stopped | Off`, and `Stopped` is any standing stop on a not-done record.** `StoppedInAudit` becomes `Stopped`; `Off` is only "no record" or "`done`". Under `Live` and `Stopped`, `join_ready` is `latest == Audited` and nothing else. The hand-driven arc — no record — is untouched, and `ops.rs`'s `Off` matrix passes `Off` explicitly, so it stays verbatim. Two tests invert rather than get deleted: `a_stopped_wheel_releases_the_offer_over_a_real_log` becomes "a stopped wheel holds the offer until the audit marks", and `stopped_early` in `the_wheel_reading_is_the_records` reads `Stopped`. This one change closes the incident end to end [F03]: no readiness, no pilot, no candidate, no offer, no auto-entry, no `Ready to join`.

**[B03] The register speaks for a stop at the seam, and stays silent for a stop mid-walk.** With `join_ready` shut the derived stage reads `implementing`, and today's register is silent for a stop in implement (`arc-join-register.test.ts:490`). Silence is right when the run is incomplete — the arc is not finished and there is nothing to decide — and wrong when it is complete, because a person now has to choose. The `auditStopped` arm generalizes to *stopped-unaudited*: run not done, stopped, derived stage not `audited`, and the walk over. Phase `awaiting`, word `unaudited`, in the `acted` set so it passes the early gate. Two sentences: the existing `<arc>'s audit stopped — resume it, or land it unaudited` for a stop in the audit stage, and `<arc> stopped before its audit — resume it, or land it unaudited` for a stop in an earlier stage with the run complete. `a stopped wheel does not hold the surface hostage` inverts; the `early` case keeps `null` for an incomplete run and gains a sibling for a complete one.

**[B04] `run_complete` goes on the wire as the server's own fact.** The deck needs to know the walk is over [B03], and `ArcDetail` already knows [F08]. Add `run_complete: bool` to `ChangesetEntry::Arc` (skipped when false) rather than deriving it in the deck from `run_position === run_length` or the step counters — that would be a second reader of the arc log, and the readers disagreeing about one arc is the shape this whole incident is made of.

**[B05] A resume from a stop with the run complete opens the audit, not the implement stage.** In the predicate's resume arm: when the stopped stage is `implement`, `ledger.run_complete` is true and no audit is declared, the action is `Rotate(Audit)` rather than re-seating implement [F06]. A fresh seat is what an audit wants anyway — it reads the diff cold. This is the half that makes "pick up the audit later" literally what Resume does. The `arc-stage audit` line the rotation writes must clear the standing `resume` exactly as a re-rotation of implement would; that is to be checked, not assumed.

**[B06] The doctrine is rewritten where it stands.** `tuglaws/arc-lifecycle.md:230`'s last sentence becomes: a stop in any stage of a wheel-driven arc is the same fact — the audit has not marked — so the offer waits for it whichever stage the stop names; the escape from a broken wheel is the unaudited join, which is the user's act and is never called ready. The `join_ready` docblock in `log.rs:694` loses its "escape" paragraph for the same words. `arc-implement/SKILL.md:154,205` already say the draft is provisional and the arming event is the audit's mark, and stand as written.

**[B07] Pinned where each fact lives.** Unit: `log.rs` gains a `join_ready` case for `Stopped` in implement with `run_complete` true and no `Audited`; the `ops.rs` real-log test inverts per [B02]; the register table per [B03]; `arc.rs`'s predicate gains the resume-to-audit case per [B05]. App: a sibling of `at0513-arc-stopped-audit` drives a planned arc to every step closed and stops it with `tugtool arc stop` — a person's stop, `stopped by user` — and asserts the row reads `stopped · you stopped it`, the register reads `unaudited`, `Ready to join` stands nowhere on the row, and the entry carries no `join.offer`, so the session card never enters Changes on it.

---

## Open Questions {#open-questions}

- Whether "land it unaudited" actually works from the deck on a stopped arc. `/arc-join <name>` is the door, `ensureCandidate` runs the ladder on mode entry, and nothing in `tugtool` refuses an unready arc [F07] — but the path has not been driven on a stopped arc, and the sentence in [B03] promises it. Driving it once, in the same arc, settles this.

---

## Non-goals {#non-goals}

- **Moving the arc track's lit cell to `audit` for a stop at the seam.** The strip lights the cell the stop names (`tug-arc-track.tsx:271`), and the stop happened in implement. The register's sentence is where "the audit is what is owed" gets said; the strip stays a record of where the stop landed.
- **Gating `arc join` on `join_ready`.** The unaudited join is the escape [B01] depends on; refusing it would turn a stopped wheel into the hostage the original escape was built to prevent.
- **A stop reason that is excepted from the wait.** Considered and rejected for the audit stage in the stopped-audit brief, and rejected here for every stage on the same ground: whoever stopped it and why, the audit did not mark.
- **Treating the provisional draft as evidence of anything.** It exists so a stopped arc has a message on the shade [F05]; it neither arms nor should it be withheld.

---

## Exit {#exit}

An arc. The first thing that lands is [B02] — the one server change that closes the incident on its own, with its two inverted tests and the `log.rs` docblock. Then the wire fact [B04] and the register [B03] together, since one is nothing without the other; then the resume arm [B05]; then the doctrine [B06] and the app-test [B07], with the open question driven along the way.
