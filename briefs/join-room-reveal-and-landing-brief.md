<!-- brief-skeleton v1 -->

# The Changes room: reveal once per piece of work, and never over its own landing

**Purpose:** Two interactions around a finished arc are flaky. The Changes shade sometimes does not reveal itself when an arc is ready to join, and a Join submitted from the shade sometimes leaves the shade standing with no progress indicator. Both must be rock-solid.

---

## Purpose {#purpose}

In the user's words: "Sometimes the changes shade is not revealed after an arc finishes. Sometimes, the join progress indicator doesn't show and the changes shade stays in place after submitting the commit message in the changes shade for a join. Both of these interactions should be *rock-solid*."

The two complaints turn out to be one mechanism seen from two sides. The passive reveal of the Changes room keeps a memory of what it has already shown, and that memory is keyed on the wrong fact and written by the wrong event. When the memory is stale the room reopens over the user's own landing (the second complaint). When the reveal defers, nothing records why, so a room that was never due and a room that failed to open are indistinguishable (the first complaint).

---

## Evidence {#evidence}

**[F01] The Join press and the passive reveal race in the same commit, and the reveal wins.** The land hook installed at `tugdeck/src/components/tugways/cards/session-card.tsx:2135` parks the join, exits the mode and hides the shade. In the next React commit the reveal effect at `session-card.tsx:3232` runs its gate again; every input is now clear (no landing active, shade hidden, composer restored to an empty prompt). The only thing that can hold it is `alreadyRevealed`, a mount-local set written in exactly one place: when the passive reveal itself fires. When the head was never spent, the effect calls `enterChanges()` again, join mode re-enters, and the coupling effect at `session-card.tsx:2043` raises the shade before its exit animation has finished. **(verified by reading the code; the ordering is declaration order of two `useEffect`s in one component.)**

**[F02] A re-entry erases the running join's narration and holds the shade until the join lands.** `JoinModeController.enter()` at `tugdeck/src/lib/join-mode-controller.ts:622` sets `narration = null`, so the register that would have read "Joining…" loses its subject. The `performJoin` done handler (line 948) calls `exit()`, so the shade drops only when the server answers. The progress row renders at the transcript's live edge, behind the shade. The user sees: no indicator, shade stays, shade drops by itself when the join finishes. **(verified by reading the code.)**

**[F03] The staged landing's watchdog does not fire in this shape, and the logs agree.** The sheet's exit animation completes and `sheetDidHide` fires normally before the remount, so `createStagedLanding`'s deadline is disarmed. The instance's October `tugcast.log` files carry no "sheetDidHide never fired" line at all, and every join `landing-receipt` but one (an `empty-message` refusal on 2026-10-22) has `verdict=ok`. So the user's failed presses were accepted presses whose room came back. **(verified against `~/Library/Application Support/Tug/instances/release-main/Logs/`.)**

**[F04] Two ordinary routes leave the head unspent.** (a) The room was opened by a hand door while a reveal gate was holding. `shouldRevealJoinOffer` (`tugdeck/src/lib/join-offer-reveal.ts:57`) defers on a turn in flight, a non-empty composer, a fold or any shade showing; the Z4A segment, ⌃⌘C, the Session menu and `/arc-join` all enter join mode without touching the memory. (b) The arc head moved while the room was open and the new head was deferred on "shade showing". **(verified by reading the code.)**

**[F05] Base motion moves the arc head, so the memory's key is not stable across a neighbour's join.** `tugrust/crates/tugcast/src/feeds/base_motion.rs:246` replays a ready arc with `git rebase` when the base moves; `standing_offer` in `tugrust/crates/tugcast/src/feeds/join_board.rs:367` keys the offer's `request_id` and `arc_head` on `rev-parse` of the branch. The comment at `session-card.tsx:3195` ("a base move does not" move the arc head) is therefore wrong, and a neighbour's join reopens every other ready arc's room. Tonight's log shows the shape inside eleven seconds: Join accepted for `body-lifecycle-closing-tail` at 22:12:52Z, base motion replayed and the pilot re-reconciled `workspace-create-flash` at 22:12:53Z, Join accepted for `workspace-create-flash` at 22:13:00Z. **(verified: the rebase and the key are in the code; that the second room was open at 22:12:53 is inference.)**

**[F06] An offer is withheld or deferred for many reasons, and none of them is recorded.** Server side, `join_board.rs:263` offers only when a candidate stands, no resolve or join run holds the arc, and no question or stuck line stands; `arc_entries` in `tugrust/crates/tugcast/src/feeds/changeset.rs:1745` skips the pilot while any segment of the holder's session line is busy. Client side, the five gate inputs above defer. The only visible trace of a deferred offer is the dot on the Changes segment. There is no reveal receipt in any log, where land presses already leave `landing-receipt` lines. **(verified by reading the code and grepping the logs.)**

**[F07] The composer's emptiness signal is not the cause of a stuck deferral.** `restoreEditState` (`tugdeck/src/components/tugways/tug-text-editor/state-preservation.ts:224`) dispatches a real transaction, so the update listener's `reportEmptiness` runs on both landing-mode swaps and `composerEmpty` returns to true on exit. This hypothesis was checked and ruled out. **(verified by reading the code.)**

**[F08] The join run does hold the offer shut, but only after the server has recomposed.** `JoinRunKind::Join` is a run, and `run.is_none()` is part of the offer's `quiet` flag, so the feed withdraws the offer once occupancy is acquired and the feed recomposes. The window in F01 is the client's own next commit, which precedes any recompose. A client-only gate is needed whatever the server does. **(verified by reading the code.)**

---

## Decisions {#decisions}

**[B01] The reveal never fires for an arc whose landing this card has in flight.** `shouldRevealJoinOffer` gains a `landingInFlight` input, true while the join snapshot is narrating, while the join store's land progress for that arc is non-terminal, or while the verb store's join phase for the card's entry key is pending. This closes F01 on its own, needs no wire change, and is the first thing to land. It is a dependency of the effect like the others, so a deferral on it re-runs when the join settles.

**[B02] Any entry into join mode for an arc spends its standing offer.** The bookkeeping moves out of the passive path and into the one place every door passes through: the join mode becoming active for an owner id while an offer stands for it. The passive reveal then asks only "has this work been shown in this room", and the answer is the same whichever door opened it (F04a). The Arcs-card row path (`revealChanges`) already spends; it becomes a special case of the rule rather than the only one.

**[B03] The memory keys on a work id the server mints, stable across base-motion replays.** `ArcJoinOffer` gains `work_id`, derived from the arc's own rounds (the round count or the last round's id from the arc log), never from a sha the rebase rewrites. `request_id` and `arc_head` stay for the rows that read them. The client remembers `work_id`. A base move then re-reconciles in silence as the comment at `session-card.tsx:3195` already claims (F05), and a new round still summons the room, which is the one thing the old key got right.

**[B04] Entering join mode on an arc whose join is running keeps the narration.** `enter()` on a target equal to the arc being narrated, while its land progress is non-terminal, does not null the narration (F02). The press on such a room is already refused by the gate's `pending` arm; the controller's aim must not quietly discard what the register is saying.

**[B05] Every deferral and every withheld offer leaves a receipt, in the same channel the land press uses.** The client sends a reveal receipt through `sendLandingReceipt`'s channel with a verdict (`revealed` or `deferred`) and the gate's first failing reason, once per `(work_id, reason)`, so it lands in `tugcast.log` beside the landing receipts. The server logs why `standing_offer` withholds (no candidate, run held, question, stuck, holder busy) at the same once-per-change cadence. The next report of "the shade did not reveal" is then answered from the log rather than by reading code (F06).

**[B06] The Changes segment's dot says why the room is waiting.** The dot already marks a standing offer on a closed room. Its tooltip carries the current deferral reason in the gate's own words ("opens when the turn finishes", "opens when the composer is empty", "unfold to open"). A deferral is then quiet rather than silent, which is the standard at0445 already states.

**[B07] The staged landing grows a tripwire.** While a callback is parked, a `sheetWillShow` on the same card is a fault: warn "room re-entered during a staged landing" through the dev log so it reaches `tugcast.log`. This is the line that would have named F01 on its first occurrence.

**[B08] The direct hide in the land hook stays.** It is idempotent and correct; the defect was the re-entry, not the dismissal. Nothing in this work adds hops to the press's own closing of the room.

---

## Open Questions {#open-questions}

- **Does at0445's base-move step actually trigger a replay?** `tests/app-test/at0445-join-reveal.test.ts` claims "closing costs nothing across a base move", but F05 says a replay moves the key. Either the fixture's base move does not replay the arc (and the claim is untested) or the test is already red on `main`. The implementer settles this by reading the fixture's base-move step before touching the test; the answer decides whether the at0445 variant in Exit is a new assertion or a repair.

---

## Non-goals {#non-goals}

- **Making the reveal a durable, cross-mount state.** The mount-local memory stays mount-local; the worst case of forgetting is one extra glance, which [D147] accepted. The key changes (B03), not the lifetime.
- **Moving the progress row into the shade or the composer.** at0472 settled that the register is transcript ink. The fix is that the shade does not stand over it, not that the register follows the shade.
- **Reintroducing any dismissal mark.** at0445 retired the durable "not now" record after the `git config --unset-all` incident. Spending a work id on entry (B02) is memory of what was shown, not a refusal, and it is mount-local.
- **Changing the server-side offer gate's conditions.** Holder-busy, run-held, question and stuck are all correct reasons to withhold; this work makes them legible, not different.

---

## Exit {#exit}

An arc, in two halves that can land in this order.

Client half first, because it removes the user-visible defect without a wire change: the `landingInFlight` gate input (B01); spending on every door (B02); the narration-preserving `enter()` (B04); the staged-landing tripwire (B07); the segment tooltip (B06); the client reveal receipt (B05). Unit coverage in `tugdeck/src/lib/__tests__/join-offer-reveal.test.ts` (new input; hand-opened room spends), `join-mode-controller.test.ts` (`enter()` on a narrating arc keeps the narration) and `staged-landing.test.ts` (tripwire). App coverage as a variant of at0496: open the room by a hand door under a held gate, press Join, assert the sheet is gone from the DOM and stays gone until the receipt lands, with the register in view throughout.

Server half second: `work_id` on `ArcJoinOffer` (B03) with the client memory re-keyed on it, and the withheld-offer log lines (B05). Coverage in `join_board.rs`'s tests (a replay keeps `work_id`, a new round changes it) and a variant of at0445 that moves the base with a real replay and asserts a closed room stays closed, after the open question above is answered.
