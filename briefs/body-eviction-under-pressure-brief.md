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

*The default, 2026-10-21.* `evictAfterMs` is fifteen minutes, offered beside 5 m, 30 m and 1 h. Stage 1's record says dormancy frees no memory (a 500-turn body holds about 550 MB dormant or not) and that eviction's rebuild is about half a second, so the delay only has to be long past a glance away: well past the dormant minute, short enough that a workspace left for a quarter of an hour stops holding its memory. It lives beside `dormantAfterMs` in `dev.tugapp.body-dormancy`; the shell reads it and tells the host (`bodyEvictAfter`), whose clock it is, and the host evicts a card's hidden page — never a sibling, which pressure alone takes — once it has been hidden that long, asked as pressure asks so a body the placement named visible is never taken ([B06]).

**[B02] Eviction is a save and a destroy, and the card is a body card still.** The host runs the page's `saveState` and removes the view, as `destroy(save: true)` does; the shell marks the card `evicted` in `bodyCardsStore`, detaches it on the bus, and keeps its facts ([F05]). The card's record, binding, seating and session are untouched, and tugcast sees a page leave, which the sweep reads as nothing because the seating stands.

**[B03] A reveal of an evicted card is an arrival.** When the placement names an evicted card shown, the shell hands it off again with intent `restore` and the bag it holds; the spare takes it; the restore pass resumes the session (a reconnect, not a respawn) and replays the window; the paint gate reveals it under the lid. It is held to row 1's bar — no frame of canvas, no frame of bare window — and its cold time goes on record. A sibling tab evicted under pressure comes back the same way when its tab is chosen.

*Resolved while building, 2026-10-21.* Two readings of the code revised the letter of this decision; its purpose — the card comes back whole, with nothing of the floor showing — is unchanged.

- **No bag from the shell.** The shell's bag for a card is the seed it handed the first body; a body writes its state to tugbank directly (`putCardState`), never back through the shell, so the shell's bag is older than what the evicted page wrote at its `saveState`. Handing it over would restore a stale draft. The card is asked for again the way a failed body is (`askAgain`): `restore` for a Session card with a binding, `mount` for a mount kind, with no bag, and the new page reads what the evicted one wrote.
- **The lid is the host's last frame.** A placement cannot "name an evicted card shown": `bodyVisible` requires `painted`, and the shell's page is paintless beneath every card (`shell-and-bodies.md`, `at0747`), so it can draw no lid either. Between the hand-off and the new page's first frame the pane would show the floor. So the host takes a snapshot of the body as it evicts it, and stands that frame over the new body (`BodyCoverView`) until the page paints. The shell asks again for an evicted card the deck wants shown (`wantsBodyShown`: active in its pane, workspace shown, not arriving) and marks it revived, which the placer reads as painted, so the card is placed visible from the hand-off under its cover.

**[B04] A pending ask is redelivered, and a row proves it.** [F03] is held by a row: a session's ask pending in a body, the body evicted, the card revealed, the dialog standing again and answerable, the answer reaching tugcode.

*Held, 2026-10-21.* `row-40-ask-redelivered`: a `tugtool host ask` caller's question standing in a sibling's dialog, the sibling evicted by critical pressure. The caller stays blocked while the card has no body, the dialog stands again in the new page 519 ms after the tab is chosen, and the answer given there releases the caller with its value. [F03]'s crossing held with no code change.

**[B05] The Layout card's Bodies row says what the deck holds, with no count that gates anything.** Beside the existing row: how many bodies are shown, sibling, dormant and evicted, and the host's last pressure event with its time. These are readings; nothing in them is a threshold. The two time settings stand beside it.

*Built, 2026-10-21.* The Layout card had no Bodies row before this. Its Rest row (`dormantAfterMs`) now has a Release row (`evictAfterMs`) under it, followed by two caption-and-text readings with no focus stop: Bodies and Pressure. Bodies counts five tiers, a fifth beside the four named here. It adds `hidden`, a card in a parked workspace still within its dormant delay, so that every body card is counted in exactly one tier. A folded card counts as shown (the fold reading, under Open Questions). The shell computes the counts from each body's state, its page's `card.facts` `dormant` and its placement, and publishes them with the host's last pressure event (`onBodyPressure`) as `deck.bodies`. `row-42-bodies-row` holds the rows.

*Reversed, 2026-10-22.* `4f3c12e34` removed the Rest, Release, Bodies and Pressure rows from the Layout card, and `row-42-bodies-row` with them (`row-42-warning-keeps-spare` took its place). The body-lifecycle second fixups then deleted what fed them: the census (`lib/body-census.ts`), `deck.bodies`, the host's `bodyPressure` message to the shell, and the two delay preferences. The tier a card is in is named to the user nowhere, and the two delays are constants (`DORMANT_AFTER_MS`, 60 s; `BodyLifecycle.evictAfter`, fifteen minutes) that only the app-test harness shortens, through `__tug.bodyDelays` ([D219]).

**[B06] Eviction never races a reveal.** A body the placement is about to show is not evicted in the same turn; the host evicts only bodies the last placement did not name visible, and a placement that names an evicted card shown is answered by [B03] rather than by un-evicting a view that is already gone.

---

## Open Questions {#open-questions}

- **Does the spare stay under pressure?** A warm spare is 146–148 MB; under *critical* it is evicted with the rest, and the next arrival is cold. Whether *warning* keeps it is decided from the first pressure reading on the user's deck.
  *Decided, 2026-10-21: a warning keeps the spare.* The deck was read without being driven. It was running stage 1, with 26 page processes holding 6.6 GB of WebKit footprint, 75–509 MB each, on a 128 GB machine at about 80 GB resident. The kernel's pressure level read normal, and the 4.5 h of retained log carried no system warning. WebKit's own relief ran 15 times, each in one process, minutes apart. The deck has not met a warning, so the decision rests on the arithmetic. One hidden body frees more than the 146–148 MB spare does, and the spare is what keeps the next arrival at 109–148 ms instead of 419–463 ms cold. So a warning takes hidden bodies and keeps the spare, and critical takes the spare too. That is the host as built; `row-42-bodies-row` asserts the spare stands through a warning, and `row-38`/`row-41` that critical takes it. The program brief's record carries stage 2's row.
- **A fold's hidden body.** A folded card hides its body at the commit and shows it at the land (stage 3 of the per-card program); a folded card evicted while folded unfolds as an arrival. Whether the unfold's beats tolerate that is a reading in this stage, held to row 14's bar.
  *Read, 2026-10-21: the case does not arise.* The question's premise has moved. A fold no longer hides a body: every card draws its folded form in its own page (the Session card's Z2 band, or the generic bar its chrome draws) and stays placed visible at the folded strip (`card-placement.ts`, `bodyVisible`). A folded card is a shown card, and a shown card is never evicted, so the unfold is never an arrival. A Text card folded as row 9's set-up reads `visible: true` at a 165 px strip. `row-41-fold-pressed` holds the guarantee against the strongest case: a Session card is folded and critical pressure is raised. The spare goes and the folded body stays, shown, on all 15 readings across 1.5 s. The unfold then carries that same body to its open box under row 9's carried bar, row 14's bar for a carried body: 0 frames of floor or bare window in motion, the host within 115 px of the placeholder against a 275 px bar, and landed on it to the pixel. Nothing in the unfold's beats needed changing.

---

## Non-goals {#non-goals}

- **A count of anything as a trigger.** The user's rule.
- **Evicting a shown card.** Never, under any pressure.
- **Evicting the shell or the overlay.** They are the deck.
- **A transcript cache to make the reveal faster.** `at0749` priced the replay at 2–3 ms.

---

## Exit {#exit}

**An arc.** In order: the host's pressure source and the eviction act with its `evicted` report; the shell's `evicted` mark and the reveal-as-arrival with row 1's bar; the time trigger from stage 1's reading; the ask-redelivery row; the fold reading; the Layout card's row; the pressure reading on the user's deck into the program brief's record.
