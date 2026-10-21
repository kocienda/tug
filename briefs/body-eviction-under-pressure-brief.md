<!-- brief-skeleton v1 -->

# Body eviction, by time hidden and by memory pressure

**Purpose:** A dormant body still holds a WebContent process. This brief lets the deck give the process up — after a body has been hidden long enough, or when the machine says it is short of memory — and brings the card back as an arrival when it is next shown, through the restore path that already exists. Nothing is counted. Stage 2 of `briefs/body-lifecycle-program-brief.md`.

---

## Purpose {#purpose}

The user's rule: "There *must not* be an arbitrary count to cards. Just like Safari will never stop you from adding another tab." And the premise the reading confirmed: the session runs in tugcast whether or not a page shows it, and a page brought back resumes it in under half a second whatever the session's length.

---

## Evidence {#evidence}

**[F01] Destroying a body loses nothing that is not written.** `BodyViewController.destroy(cardId:save:)` calls the page's `saveState` and removes the view; the body's `saveState` runs `deck.saveNow({sync: true})`, which writes the card's state bag to tugbank. The card's binding (`card.binding`, shell-owned), its seating (reported by the shell) and its session (held by the seating) all stand. `row-11-lifecycle` reads the draft typed before a reload out of the bag on disk after it. **(verified, read)**

**[F02] A recreated body is an arrival.** `handOffToBody` (`lib/body-handoff.ts:173`) posts `bodyCreate` with the shell's bag as the intent's `bag`; the spare takes the card if one is waiting (`BodyViewController.bind`); the body restores through the restore pass, and the shell reveals it through the paint gate under the lid. Warm bind → ready was 109–148 ms at stage 2 of the per-card program; the terminated reload was 419–463 ms to ready in `at0749`, with a cold page. **(verified, measured)**

**[F03] A pending ask survives a body's absence.** `sessionAsk` is a request with a person horizon declared `redeliver`: a request still pending when the card's body detaches is sent again when its body next attaches (`tuglaws/shell-and-bodies.md#requests`). Not yet exercised across a destroy and a recreate. **(verified, read; the crossing is inference until its row runs)**

**[F04] The host has a memory-pressure source and uses none.** `DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical])` is public API; `tugapp/Sources/` references none of it. **(verified, read)**

**[F05] The shell-side mark of a gone body.** On `terminated` the shell detaches the card and marks it `creating`; on `failed` it forgets the card's stores and re-seeds them (`lib/body-shell.ts`, `onBodyState`). A card-owned replica keeps its last value on detach unless `clearOnDetach`; `card.holds`, `card.surface`, `card.painted`, `card.restoreHold` and `card.inspection` clear, `card.facts` does not. So a card's masthead facts stand while its body is gone. **(verified, read)**

---

## Decisions {#decisions}

**[B01] Two triggers, no count.** A dormant body is evicted when it has been hidden for `evictAfterMs` (default from stage 1's reading of a dormant body's resident size; the program brief's record names it), or at once under memory pressure: on *warning* the host evicts dormant bodies oldest-hidden first until the warning clears or none are left; on *critical* it evicts every hidden body, siblings included, and the spare. Both are the host's acts, since the host holds the views and the pressure source; the shell is told by a new `evicted` state in `bodyStateToPage`. No setting, default or diagnostic expresses a number of bodies.

**[B02] Eviction is a save and a destroy, and the card is a body card still.** The host runs the page's `saveState` and removes the view, as `destroy(save: true)` does; the shell marks the card `evicted` in `bodyCardsStore`, detaches it on the bus, and keeps its facts ([F05]). The card's record, binding, seating and session are untouched, and tugcast sees a page leave, which the sweep reads as nothing because the seating stands.

**[B03] A reveal of an evicted card is an arrival.** When the placement names an evicted card shown, the shell hands it off again with intent `restore` and the bag it holds; the spare takes it; the restore pass resumes the session (a reconnect, not a respawn) and replays the window; the paint gate reveals it under the lid. It is held to row 1's bar — no frame of canvas, no frame of bare window — and its cold time goes on record. A sibling tab evicted under pressure comes back the same way when its tab is chosen.

**[B04] A pending ask is redelivered, and a row proves it.** [F03] is held by a row: a session's ask pending in a body, the body evicted, the card revealed, the dialog standing again and answerable, the answer reaching tugcode.

**[B05] The Layout card's Bodies row says what the deck holds, with no count that gates anything.** Beside the existing row: how many bodies are shown, sibling, dormant and evicted, and the host's last pressure event with its time. These are readings; nothing in them is a threshold. The two time settings stand beside it.

**[B06] Eviction never races a reveal.** A body the placement is about to show is not evicted in the same turn; the host evicts only bodies the last placement did not name visible, and a placement that names an evicted card shown is answered by [B03] rather than by un-evicting a view that is already gone.

---

## Open Questions {#open-questions}

- **Does the spare stay under pressure?** A warm spare is 146–148 MB; under *critical* it is evicted with the rest, and the next arrival is cold. Whether *warning* keeps it is decided from the first pressure reading on the user's deck.
- **A fold's hidden body.** A folded card hides its body at the commit and shows it at the land (stage 3 of the per-card program); a folded card evicted while folded unfolds as an arrival. Whether the unfold's beats tolerate that is a reading in this stage, held to row 14's bar.

---

## Non-goals {#non-goals}

- **A count of anything as a trigger.** The user's rule.
- **Evicting a shown card.** Never, under any pressure.
- **Evicting the shell or the overlay.** They are the deck.
- **A transcript cache to make the reveal faster.** `at0749` priced the replay at 2–3 ms.

---

## Exit {#exit}

**An arc.** In order: the host's pressure source and the eviction act with its `evicted` report; the shell's `evicted` mark and the reveal-as-arrival with row 1's bar; the time trigger from stage 1's reading; the ask-redelivery row; the fold reading; the Layout card's row; the pressure reading on the user's deck into the program brief's record.
