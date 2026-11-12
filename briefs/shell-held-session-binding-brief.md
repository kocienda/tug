<!-- brief-skeleton v1 -->

# A Session Card the Shell Binds Never Gets Its Body

**Purpose:** A parked workspace's session cards can be resumed by a spawn the shell did not send, before the workspace is first shown. The shell then holds their bindings itself, every route to a body page is closed, and the workspace's session panes stay blank for the rest of the run.

---

## Purpose {#purpose}

The report, on 2026-11-12, against the `release-main` instance:

> This `phraso` workspace is broken. Why? When I switch to it, the open session cards never show.

The workspace's sidebars drew. Its two session cards (`phraso/mature-sloth`, `phraso/dainty-foyer`) showed one empty pane frame and nothing else, on every visit. The other four workspaces on the same deck were fine.

---

## Evidence {#evidence}

All times are UTC. The instance is `release-main`, running the Release build out of DerivedData from this checkout; the readings are from its `tugapp.log` and `tugcast.log` for 2026-11-11 and 2026-11-12, a copy of its `tugbank.db`, `tugtool deck pages`, and the shell's `__deckTrace` ring read through the eval door.

**[F01] The two cards have no body page.** `tugtool deck pages` listed a body page for every card of every workspace in the saved layout except `6d1f2c75-aa0e-4e75-9419-cc2e04054fc4` and `d4e65036-158f-43dc-a768-7a7539f914a5`, the phraso workspace's two session cards. The app log's last `bodies:` lines for either are at the quit at 2026-11-11T14:57:15; no `page loaded`, `ready` or `painted` line names them in any launch since. A switch into phraso holds for its five sidebar cards only (`switch hold … serial=23 waiting=` lists no session card). **(verified)**

**[F02] Nothing saved is damaged.** The saved layout (`dev.tugapp.deck.layout`) holds the phraso workspace with both session cards in panes in slot 0; both cards' state bags (`dev.tugapp.deck.cardstate`) are whole, last written 2026-11-11T14:57:15; the ledger binds each card to its session (`349b1c3a…`, `ff7e93b1…`), and `tugtool session find` answers `here` for both. **(verified)**

**[F03] The sessions were resumed while phraso was parked.** tugcast logged `spawn.supervisor_recv … session_mode="resume"` for both cards at 14:17:20, and again at 14:24:31 and 14:33:15. The first switch into phraso in that run of the shell was 14:29:53. The shell's trace shows Main's pane active (`activePaneId=49ba10b8…`) at the 14:17:20 acks. **(verified)**

**[F04] The shell did not send those spawns.** Each ack is followed in the shell's trace by `spawn.ack_without_reason`, the branch `session-control-actions.ts` takes when `takePendingReload(cardId)` is empty — its own comment: "An ack this page sent no spawn for (a body's card, seen by the shell) has none." A spawn the shell sends through `fireRestore` registers a reason first. **(verified)**

**[F05] The shell built stores for the two cards, and for no other.** At the 14:17:20 acks the trace records `services_store.construct` for both phraso cards. No other card on the deck has that event in the 431-event ring. `CardServicesStore._servesCard` builds services in the shell for any bound card that is not in `bodyCardsStore`. **(verified)**

**[F06] A shell-held binding closes every route to a body.** Read from the code:

- `restoreSpaceSessions` (`tugdeck/src/lib/session-restore.ts`) skips a card with a binding: `if (cardSessionBindingStore.getBinding(cardId) !== undefined) continue;`. The trace confirms it at the phraso visit: `restore.space_pass space_card_count=2 restore_count=0 fresh_spawn_count=0`.
- `sessionCardToHandOff` (`tugdeck/src/lib/body-shell.ts`) requires `getBinding(cardId) === undefined || keptBody(cardId)`.
- The make-ahead pass (`tugdeck/src/lib/body-make-ahead.ts`) takes a Session card only when the ledger binds it to nothing.
- `measurePlacements` (`tugdeck/src/lib/card-placement.ts`) posts no placement for a card that is not in `bodyCardsStore`, so the host is never told the card exists.

**(verified)**

**[F07] The sender is not identified.** tugcast reaches `do_spawn_session` from one place, the `spawn_session` control frame, so a page sent it; `spawn.supervisor_recv` does not log the client id. A body page's deck holds only its own card (`body-card-deck.ts`), so a body's own restore or reconnect pass cannot name another card. Of the body pages that answered a trace read through the eval door, none recorded an event naming either card; seven pages did not answer (six timed out, one refused), and the phraso Workspaces and Overview pages refused an earlier read. The two sessions working on the deck at the time (`tug/fond-dove`, `tug/daring-spout`) have no mention of either card or of `spawn_session` in their transcripts. **(not established)**

**[F08] The stray resume is not confined to phraso.** At 14:24:25 the shell's trace shows resume acks for `256d025b…` and `90b837cc…`, two cards that are in no workspace of the saved layout, though both still have state bags. Parked workspaces whose session cards do have pages show resume acks arriving in per-workspace groups at the same moments; for those the ack is harmless (`inserted=false`). That the sender works from ledger bindings rather than from cards on screen is an inference from this pattern, not a reading. **(inferred)**

**[F09] The shell page reloads during a run.** `launch: reveal` lines at 01:48, 02:08, 10:45, 12:45 and 14:13 mark shell reloads within one app launch, the last beside `WebContent process terminated — reloading`. Each empties the shell's binding store, so each opens a fresh window in which a stray resume can land ahead of a workspace's first visit. After the 14:13:25 reload the stray resume for phraso came 3 min 55 s later. **(verified)**

---

## Decisions {#decisions}

**[B01] The defect to fix is the dead end, not only its trigger.** A spawn ack for a body-kind card that has no page, which the shell did not ask for, must end with the card in a body, not with the shell holding stores for it. Whatever sent the resume, the shell's answer to it is what makes the card unrecoverable ([F05], [F06]), and a second sender tomorrow would strand a card the same way. The shell holding a session card's stores has no drawing path under body views, so there is no case where that state is the wanted one.

**[B02] tugcast logs the sending client at `spawn.supervisor_recv`.** The sender in [F07] could not be named from the record, and a page sweep through the eval door is slow and incomplete. One field on an existing log line names it the next time.

**[B03] The stray sender is found and stopped in the same arc.** [B01] makes the stray resume harmless to the pane; it still resumes sessions for parked workspaces at moments nobody chose, and for cards that are in no workspace ([F08]). With [B02] in a build the sender is one log line away, and the arc that surfaced it owns it.

**[B04] The fix is proven by a test that strands a card the way phraso's were.** A parked workspace's bound session card, an ack for it that the shell did not send, then a switch to the workspace: the card must come up in a body. The bus-level tests beside `tugdeck/src/lib/__tests__/card-binding-bus.test.ts` are the fast layer for this; an app-test is the verdict only if the unit layer cannot hold the sequence.

---

## Open Questions {#open-questions}

- **How does [B01] hand the card off without starting a second session?** The make-ahead pass refuses bound Session cards because "a page made ahead of that pass would be handed the pass's decision afterwards and spawn a second session". Here the session is already resumed in tugcast under another socket, so the body would be handed a `resume` of a live session. Whether that is a plain re-hold (as `inserted=false` suggests) or needs its own intent has to be read out of `handOffToBody`, `intentToAskAgain` and the supervisor's resume path before the change is shaped.
- **Does the card become a body at the ack, or at its workspace's first visit?** At the ack the workspace is parked, where the deferral would stand the card `unmade` until shown. Leaving the binding alone and teaching `restoreSpaceSessions` and `sessionCardToHandOff` to accept "bound, no page, no stores of the shell's making" is the other shape. The answer follows from the first question.
- **Who is the sender?** Unanswerable from today's record ([F07]); [B02] settles it.

---

## Non-goals {#non-goals}

- **Repairing the user's phraso workspace by hand.** Nothing saved is damaged ([F02]). Closing the two blank cards and resuming each session into a new card, or switching to phraso straight after a relaunch, should bring them back; neither was tested, and neither is part of this work.
- **Stopping the shell page's mid-run reloads.** They widen the window ([F09]) but are a separate matter with their own cause.
- **The shell-and-body arc ping-pong.** Fixed in `60efa073d`; it is a different loop in the same store.
- **Pruning state bags of cards that are in no workspace.** Seen in passing ([F08]); not this defect.

---

## Exit {#exit}

**An arc.** First steps, in the order they have to land:

1. Add the client id to `spawn.supervisor_recv` ([B02]).
2. Settle the two shape questions above by reading `handOffToBody`, `intentToAskAgain` and the supervisor's resume of an already-held session.
3. Write the stranding test ([B04]) and see it red.
4. Change the shell so an unasked ack for a pageless body-kind card ends in a body ([B01]); the test goes green.
5. With step 1 in a running build, read the log for the stray sender and stop it ([B03]).
