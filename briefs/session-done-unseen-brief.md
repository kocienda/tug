<!-- brief-skeleton v1 -->

# A finished session reads Done until the user looks at it

**Purpose:** A session that finished a turn while the user was looking elsewhere drops to the same hollow idle dot as a session that has sat untouched for a day, so the Workspaces list cannot be scanned for "which of these has a result waiting for me". The session should carry a `done` reading from the turn's end until the user's attention spends it.

---

## Purpose {#purpose}

The user, reading the Workspaces card with a dozen sessions across five workspaces:

> We need a subtle change to the state when a session was doing AI work, but then finishes and goes idle. I may have been looking elsewhere, and right now, it's impossible for me to scan the list and see which session has a result and which have been idle for some time. … I need to see which sessions have *finished* doing something I asked it to do and now is ready for me to check in. … Once I click into it, I've acknowledged the work.

The ask is an unread mark on a session, raised by the end of a turn and cleared by the user's attention, and nothing else. It was settled in conversation that the mark does **not** age out: "No aging. Yes, my attention is what counts."

---

## Evidence {#evidence}

**[F01] The dot has no reading between working and idle.** `sessionSessionPhaseKey` (`tugdeck/src/lib/code-session-store/session-phase-visual.ts`) flattens a session onto one key, and the visual map gives every working phase `{ role: action, state: running }` (a filled, breathing dot) and `idle` `{ role: inherit, state: stopped }` (the hollow ring). A `turn_complete` moves the reducer's phase straight to `idle`, so the row's glyph is identical ten seconds and ten hours after a turn ends. **(verified)** by reading the module and the screenshot the user supplied: every finished session wears the ring, the one working session (`vids/chirpy-rise`) a filled dot.

**[F02] The third line does not carry it either.** The activity line's rest form (`tugdeck/src/lib/session-activity-line.ts`, `sessionActivityRestLine`) always closes with `Ready.`, and the identity row's ladder (`session-identity-row.tsx`, the `post` rung) shows the model's last post above the rest line, where one exists, indefinitely. Both are the same whether the turn ended a moment ago or long ago. **(verified)**

**[F03] "Ready" is already taken, twice.** `ready` is a phase key meaning *an arc seated on this session has finished and a join offer stands* (`use-session-phase.ts`, `joinOfferStands`, the one-door brief's [B01]); it wears `{ role: success, state: running }`. And `Ready.` is the closer of every rest line, where it means "on disk and one gesture from another turn". A new state called Ready would make a finished ordinary turn read as a joinable arc. **(verified)**

**[F04] The turn's end already has a word and a wire event.** The digester (`tugrust/crates/tugcast/src/feeds/session_digest.rs`, `on_turn_end`) writes the marker `Done` on `turn_complete` and `Stopped` on `turn_cancelled`; the deck recognizes it as `TURN_DONE_MARKER`. **(verified)**

**[F05] The dot is session-keyed and shared by every surface.** `SessionPhaseDot` reads `useSessionPhaseVisual(sessionId)`, and that hook is the one derivation the Workspaces row, the picker rows, the masthead, the Z2 STATE cell and the citation chips all mount. A key added to `sessionSessionPhaseKey` therefore appears on every surface that names a session without each one being taught. **(verified)**

**[F06] The ledger row carries no stamp of attention.** `SessionRow` (`tugrust/crates/tugcast/src/session_ledger.rs`) holds `created_at`, `last_used_at`, `turn_count`, `last_user_prompt`, `state`, `synopsis` and identity fields. Nothing records when a turn last ended or when the user last attended the session, so a reload has nothing to derive an unread mark from. **(verified)**

**[F07] Card activation is already observable.** `deck-manager.ts` exposes `observeCardDidActivate(cardId, cb)` through the card lifecycle, which is the hook the picker and others already use to learn that a card became the active one. **(verified)** that the hook exists; whether "active card" also needs "window is key" to count as attention is inference, see [B04].

---

## Decisions {#decisions}

**[B01] A session carries a `done` reading from the end of a completed turn until the user attends it.** This is the mail convention applied to a session: finished and unseen is a state of its own, distinct from both working and idle. It exists so the list can be scanned for results waiting on a person, which [F01] and [F02] show nothing does today.

**[B02] The state is named `done`, never Ready.** `Ready` is the arc's join offer and the rest line's closer ([F03]); reusing it would conflate a finished turn with a joinable arc and make the closer lie. `Done` is the word the digester already stamps on the turn's end ([F04]), so the state, the marker and the line agree.

**[B03] It is raised by `turn_complete` alone.** A cancelled turn is the user's own act and tells them nothing they do not know; `Stopped` does not raise it. An errored turn keeps its `errored` reading, which already outranks idle and wears danger. A turn that completes while its card is the one the user is attending ([B04]) never raises the mark, which is what keeps the state honest: a result read as it arrived is not unseen.

**[B04] Attention is activating the session's card, by any door, with the window key.** Clicking the Workspaces row, ⌘-digit, the picker, a citation chip: anything that makes that session's card the active card spends the mark. The window has to be key, because an active card in a background window is not being read. Submitting a new prompt spends it trivially, since the session goes back to working. Scrolling the list past the row, hovering it, or seeing its dot does **not** spend it. In the user's words: "Once I click into it, I've acknowledged the work."

**[B05] The mark never ages out.** Settled by the user: "No aging. Yes, my attention is what counts." The whole value of the mark is that the user can leave for hours and come back to a list that still says which sessions finished while they were gone. No timer, no clear-on-relaunch, no clear-on-quit.

**[B06] The mark lives in the session ledger as two stamps, and `done` is derived.** tugcast records `last_turn_end_at` when a turn completes and `last_attended_at` when the deck reports attention ([B04]); `done` holds when the end stamp is newer than the attended stamp. The ledger is the right home because the mark has to survive a reload ([B05], and [F06] shows nothing there does today), has to be the same on every surface and every page of the deck, and is a fact about the session rather than about a card. A deck-only store would forget the mark at every relaunch, which is exactly when the user most wants it. The deck reports attention through the same wire it already uses to tell tugcast about the session; the derivation is a pure function with a unit test, like `joinOfferStands`.

**[B07] `done` promotes from `idle` and sits below the arc's `ready` and below `background`.** In `sessionSessionPhaseKey` the order is transport, interrupt, stalled stop, pending ask, `ready`, `background`, `done`, `idle`. A session whose work is still running in the background is not done, so it keeps the Running diamond and its rest line keeps `Ready.`; the mark stands on the ledger row and reads once the session goes quiet (revised 2026-11-10 on the user's word; the first version put `done` above `background`). A question holding the user's answer and a standing join offer both outrank a finished answer; both are things waiting on a person too, but each already has its own louder reading, and a session wearing a join offer has finished by definition. Like `ready` and `background` it is a presentation key only: the reducer's turn phase is untouched, the composer stays open, no Stop button lights.

**[B08] The dot carries it, as a filled, still green dot.** Three readings on one glyph, in order of liveness: working is filled and breathing; `done` is filled and still; idle is the hollow ring. The triple is `{ role: success, state: completed }`, the indicator's own finished pose. It shares green with the arc's `ready` and parts from it on motion: `ready` breathes, `done` is still (revised 2026-11-10 on the user's word; the first version wore the action tone to keep `success` the arc's alone). The row's name stays regular weight and the row stays where it is: this is the subtle version the user asked for, and the one dot every surface already mounts ([F05]) is the only pixel that moves.

**[B09] The rest line's closer reads `Done.` while the mark stands and `Ready.` once spent.** `sessionActivityRestLine` takes the fact as an input and swaps one word. Where the `post` rung is showing instead ([F02]) the line is unchanged and the dot carries the reading alone. The marker word and the state agree ([B02]), and a copied or searched line says the true thing.

---

## Open Questions {#open-questions}

None that change what gets written. One judgment the arc makes from the code: whether the attention report rides an existing deck-to-tugcast message about the session or needs a small new one. Either is fine; what is settled is that the stamp is tugcast's to write ([B06]).

---

## Non-goals {#non-goals}

- **Aging, decay, or clearing on relaunch.** Rejected by the user ([B05]). Do not re-propose a timer.
- **Reusing the `ready` key or the word Ready.** Rejected ([B02], [F03]).
- **Bold or reordered rows.** The name stays regular weight and the row stays in place; the user has just landed work keeping the clicked Workspaces row where it is. A bold name is the next step up if the still dot proves too quiet on a long list, and it is held in reserve, not started with.
- **Raising on a stopped or errored turn.** [B03].
- **Spending the mark on hover, scroll, or a glance at the list.** [B04]. Only activation counts.
- **A deck-only store for the mark.** It forgets at relaunch ([B06]).
- **A notification, sound, badge, or dock bounce.** This is a reading on a list the user scans when they choose to, not an interruption.

---

## Exit {#exit}

**An arc.** The shape it takes, in the order the pieces depend on each other:

1. The ledger: two stamps on `SessionRow` with a schema migration, `last_turn_end_at` written from the digester's `turn_complete` path, `last_attended_at` written from a deck report; the pure `done` derivation with its unit test ([B06]).
2. The deck's attention report: on `observeCardDidActivate` for a session-bound card while the window is key, and on prompt submit, tell tugcast the session was attended ([B04]); the turn-completes-while-attended case never raises ([B03]).
3. The key: `done` added to `SessionPhaseKey`, flattened in `sessionSessionPhaseKey` at the seat [B07] names, labelled "Done", wearing `{ role: action, state: completed }` ([B08]); `useSessionPhase` feeds it from the ledger row the way it feeds `joinReady` from the changes feed.
4. The line: `sessionActivityRestLine` takes the fact and closes `Done.` or `Ready.` ([B09]).
5. Verification on the Workspaces card: a turn completing on a card that is not active leaves the row's dot filled and still and the line closing `Done.`; activating that card returns it to the ring and `Ready.`; a turn completing on the active card never shows the mark; the mark survives a deck reload.
