<!-- brief-skeleton v1 -->

# Arc completion calls for the user

**Purpose:** When an arc finishes, the Session card goes quiet — the dot reads Idle, the Changes shade presents once and can be dismissed, and a folded card offers no way to join or even to unfold. A finished arc is work waiting on a person, and nothing on the card says so for as long as that is true.

---

## Purpose {#purpose}

The user's words, from the two conversations this brief folds together:

> When an arc completes, we need a different state and an improved UI/UX surrounding it. Right now, the session goes *Idle* and the Changes sheet presents. Instead, we should probably switch this to a new state that calls for user interaction, probably a state related to (or actually) *Awaiting*, but maybe with a *green/success* pulsing dot. The session must call for user interaction more.

> When an arc completes in folded mode, there's no way to join, or even any way to graphically unfold. Must fix.

The first is a state problem: the card's one liveness mark has no reading for "done and waiting on you". The second is a form problem: the folded form (D185) hides every act, and the arc-finish reveal opens a room behind the fold that nobody can reach. They are one problem because the fix for the first is the only signal that survives the second: the dot is visible on a folded card; the shade, the receipt row, and Z5 are not.

The `silver-finch` session (`@tug/silver-finch`) traced the folded case against the `sheet-visibility` merge (`3bb9cf6ac`); its findings are carried here as [F05]–[F09].

---

## Evidence {#evidence}

**[F01] The dot is derived from the turn reducer, and a finished arc leaves no turn in flight.** `sessionSessionPhaseKey` in `tugdeck/src/lib/code-session-store/session-phase-visual.ts` flattens phase, transport, interrupt, background jobs, and a pending ask into one key; with none of those raised it returns the reducer's `idle`. The wheel hands the card back (`hand_back` in `tugrust/crates/tugcast/src/wheel/mod.rs`), writes the receipt row, and the turn is over. `Idle` is therefore what a finished arc reads, by construction. **(verified)**

**[F02] The seam for a non-turn reading already exists, twice.** `background` promotes `idle` to Running when the jobs ledger has live agents; `pendingAsk` promotes to Awaiting when an `/api/ask` dialog is up. Both are presentation-only keys — the reducer's phase enum is untouched — and the file's own comment names this as the deliberate shape for a fact that belongs to no turn. **(verified)**

**[F03] The indicator has a green that nothing on the session dot has ever worn.** `TugProgressIndicator` takes `role` and `state` as independent axes (`tug-progress-indicator.tsx`); `success` is a role, `running` is a state, and explicit `phaseVisual` returns may pair them. Today `success` reaches the dot only through `completed`, which is the still pose. The session-phase visual map never returns `success` at all. **(verified)**

**[F04] The Changes shade is the caller today, and a shade is dismissable.** The join offer arrives as `joinOffer.arc_head`; the effect at `session-card.tsx` (search `revealedOffersRef`) enters join mode once per head when no turn is in flight, no landing is active, the composer is empty, and no shade is showing. The head is then spent. Closing the shade leaves the card reading Idle with an unread dot on the Z4A Changes segment and nothing else. **(verified)**

**[F05] The quiet-moment gate does not consult the fold.** The four conditions in [F04] all pass on a folded card, so the reveal fires, the head is spent, and the room opens inside a form that cannot show it. **(verified, silver-finch)**

**[F06] The shade lands over the fold control.** The Changes wrapper is absolutely positioned over the top column (`session-card.css`, `.changes` wrapper); on a settled folded card that column is exactly the Z2 row. The shade's scrim keeps pointer events, so the fold control at Z2's trailing edge is under a dead zone. That is "no way to graphically unfold". ⌥⌘M and the Session menu still work because the fold handler dispatches the flag regardless. **(verified, silver-finch)**

**[F07] The Join act is folded away.** Z5 lives in the entry region, which is zero-height and `inert` when folded, so even the shade that opened offers nothing to press. That is "no way to join". **(verified, silver-finch)**

**[F08] The sheet-visibility arc did not reach the shade, correctly.** Its canvas sizing, boxless-anchor fallback, and pane lift apply to sheets; the shade presentation returns early from all three effects in `tug-sheet.tsx`. A shade is a view swap over the transcript, not a panel that can be given the canvas. **(verified, silver-finch)**

**[F09] Nothing in the folded form says an arc is ready.** The survivors of a fold are the masthead beat, the masthead dot, and the Z2 instrument row; the ARC cell reads Finished, the dot reads Idle, and D185 has nothing to say about a folded card that needs the user. There is no programmatic unfold anywhere in the deck. **(verified, silver-finch)**

**[F10] The server already has the word.** `join_ready` is the server's derivation of "this arc can be joined", and the join register (`tugdeck/src/lib/arc-join-register.ts`) reads it as `ready`; a reopen un-arms it, a stopped audit holds it shut. The Arcs card row, the Changes shade's collapsed row, and the Z2 placard all read from that one derivation. **(verified)**

**[F11] The finished receipt is a quiet line by design.** `session-arc-receipt-block.tsx` paints `<arc> Finished · N stages` in the arc-note register for an arc that finished, and keeps the full receipt with a Resume offer only for one that stopped. The stopped shape already carries a button; the finished shape carries none. **(verified)**

---

## Decisions {#decisions}

**[B01] A finished arc with a standing join offer reads as a new presentation-only phase key, `ready`.** It is derived, never declared: the input is "a join offer stands for this card and nothing has spent it" — offer present, not landed, not discarded, not reopened — which is exactly `join_ready` ([F10]), so the dot and the register cannot disagree. It rides the `background` / `pendingAsk` seam ([F02]) and leaves the turn reducer alone, so `canSubmit` stays true: Ready is a state you can keep working under. Precedence: below transport, interrupt, and Awaiting (a dead wire or a dialog holding an answer still outranks it); above `background` and `idle`. It cannot collide with Running, because an audit still committing fixups is an arc that has not finished.

**[B02] The label is "Ready", not "Awaiting".** Awaiting already means a dialog is holding a turn's answer, and this blocks nothing. Ready is the server's own word for a joinable arc ([F10]), so the dot, the Z2 ARC cell, the Arcs card, and the register say one thing.

**[B03] The dot is green and it pulses: `{ role: success, state: running }`.** Success is reserved for the done reading and has never been worn by the session dot ([F03]), so green-and-breathing can mean only one thing across the room. The pulse is truthful under the animation doctrine on the same argument Awaiting makes: the thing depicted is a live wait on a person, not a settled session. The user chose pulsing over still. Every surface that reads `useSessionPhase` inherits it — masthead dot, Z2 STATE cell, Changes card citation dots, Arcs card row — with no second mark.

**[B04] The finished receipt row grows a Join button.** The transcript's last row becomes an act, not only a fact ([F11]); the stopped shape already carries Resume, so the finished shape carrying Join is the same row grammar completed. It routes through the one reveal path (`revealChanges`, D152) and arms Z5 — the receipt does not perform the join itself, it takes the reader to the room where the join is pressed. The button is present only while the offer stands and disappears once the head is spent by a land, a discard, or a reopen.

**[B05] The composer placeholder says it while Ready.** Something like "Arc finished. /arc-join to land it, or keep working." The composer is where the eye goes when the model stops talking, and the placeholder is the one line the open form can change without adding a surface.

**[B06] The Changes room is a room of the open form; an unbidden entry waits for the unfold.** The card's `folded` flag becomes a dependency of the passive reveal effect ([F04], [F05]). Folded, the effect defers *without* spending the arc head. Because the flag is a dependency, the user's own unfold re-runs the effect and the room opens armed, exactly as it would have on an open card at a quiet moment. This keeps the quiet-moment gate's contract: a server event never reflows the wall.

**[B07] A bidden entry unfolds first.** The explicit reveal — the ARC placard's Show in Changes, an Arcs card row, the View ▸ Changes route, and the receipt's Join button from [B04] — is the user's own license. On a folded card each dispatches the unfold and lets the deferred effect from [B06] carry the entry, rather than entering the room directly. No opener of the shade is left that can mount it over Z2 ([F06]).

**[B08] The folded form announces the offer in the voices it already has, and the user must unfold to join.** The masthead dot wears Ready ([B01], [B03]) for free. The Z2 ARC cell takes the register's word when an offer stands, reading ready rather than Finished. Both come off the one derivation ([F10]). With the scrim gone ([B06]) the fold control is reachable again, and the unfold is the graphical door: two gestures from a folded card to an armed Join — unfold, then Z5. The folded form gets no Join affordance of its own: the join has one act and it lives in Z5, and the folded form's doctrine (D185) is a card being watched rather than talked to. Revisit only if D185's three doors are themselves reopened.

**[B09] Ready ends only when the offer is spent.** Land, discard, or reopen. A dismissed shade does not end it; the dot and the ARC cell keep saying Ready until the user acts, which is the whole point of the state.

**[B10] The masthead beat's rest sentence takes the register's word while Ready.** Join readiness is the higher-order fact about an arc-seated session at rest, and it outranks whatever the narration digester last said the session was doing. The beat composes the register's line on the same condition the ARC cell does ([F10]), so the folded form's two lines and its dot agree; the digester's sentence returns when the offer is spent. This is the one place a composed fact stands over a narrated one, and the condition is narrow enough to say so in the doctrine.

---

## Open Questions {#open-questions}

None. The three the first draft carried were settled by the user and are recorded as [B08], [B10], and the stopped-arc non-goal below.

---

## Non-goals {#non-goals}

- **Not a modal or blocking dialog on arc finish.** The user may want to keep working on the worktree before landing; Ready must stay a state the composer is open under. Reusing Awaiting for it would also make `canSubmit` false and `canInterrupt` true with nothing to stop.
- **Not auto-unfolding on the offer.** That turns a server event into a wall reflow the user did not ask for, which is what the quiet-moment gate exists to prevent.
- **Not extending the sheet-visibility treatment to shades.** It would give a room with no door, since the act stays in the folded-away Z5 ([F07], [F08]).
- **Not a second mark.** No chatbox icon, no badge on the masthead, no separate "done" glyph. The dot says what the session is doing; Ready is one more thing it can say.
- **Not a still green dot.** Considered as the stricter liveness reading; rejected by the user in favor of the pulse, on the Awaiting argument in [B03].
- **Not a Join affordance on the folded form.** Settled in [B08]: the user unfolds to join.
- **Not a phase key for a stopped arc.** An arc that stopped short, or whose audit stopped without marking, is a different wait — caution-toned in the register, with a Resume button already on its receipt. Worth its own sketch later; this brief covers finished arcs only.

---

## Exit {#exit}

**An arc.** The shape, in the order the pieces lean on each other:

1. The `ready` key: a new `SessionPhaseInput` field, its precedence in `sessionSessionPhaseKey`, the label, and the `success`/`running` visual, with the unit tests beside the existing `background` and `pendingAsk` cases. Then plumb the offer-stands fact into every live `useSessionPhase` source.
2. The passive reveal effect takes `folded` as a dependency and defers without spending the head; the explicit reveal paths unfold first.
3. The Z2 ARC cell and the masthead beat's rest sentence read the register's word; the composer placeholder reads Ready.
4. The finished receipt row grows Join, routed through the one reveal path.
5. App-tests in the fold family beside at0550–at0557: fold a card bound to an arc, post a join offer, assert no shade in the DOM, the fold control clickable at its own point, the dot reading Ready, the ARC cell wearing the ready word; unfold and assert the shade is up, join mode is armed, and the head was spent exactly once. A second test on the open form for the receipt's Join button and the placeholder.
6. Doctrine: a design-decisions entry for Ready as the dot's first green reading, and a "needs the user" paragraph on D185 carrying the room-of-the-open-form rule, the unfold-to-join rule, and the beat's one composed line.
