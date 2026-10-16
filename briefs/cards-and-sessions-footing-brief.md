# Cards and sessions back on a firm footing

**Purpose:** With body views on, a Session card lost a whole live turn, its question dialog never appeared, and the user had to close and reopen the card twice in one afternoon. The app-test corpus work is tabled until the basic interactions between cards and sessions hold.

---

## Purpose {#purpose}

On 2026-10-16, working in `tug/warm-alder` with the per-card web views switch on (`dev.tugapp.deck/bodies` = 1), the user reported: "InlineDialogs for question-answering has regressed. I got stuck here with no way to answer." The card showed the model's turn up to the point of a tool call, then nothing; the status bar read **Awaiting** with no dialog to answer. Minutes later: "session transcripts are losing/truncating content that was already shown. This is a ***major bug***. Data loss." The `/compact` prompt also appeared twice in the card. Then: "It feels like maybe every time I submit a prompt in another session card that the replay happens here. I needed to close and reopen this session *again*, since it got stuck as I tried to tell you this."

The user's call: "this work is in a *very rough state*. It feels like we need to table the work on the app-tests and get the basic interactions of cards and session back on a firmer footing." They turned bodies off in the Layout settings, rebuilt, and relaunched.

The transcript on disk was intact throughout: every line of the lost turn is in the session's JSONL. The loss was in what the card showed, and in the card's ability to act on it.

---

## Evidence {#evidence}

**[F01] The card asked tugcode to replay the whole session three times in four minutes, mid-session, with no reconnect, rebind or reload beside any of them.** `tugcast.log.2026-10-16` for `release-main` shows `request_replay.dispatched` for session `2fe12ffd` at 15:43:37, 15:45:29 and 15:47:21 (UTC), each reading the full 14–15 MB JSONL and translating 2371–2472 lines. The body's WebSocket (client 15) stayed up from 14:11:43 until 15:49:06; no `connectionDidReconnect` fired. The shell page's `__deckTrace` ring, read through the eval door, shows no `services_store.construct` and no `request_replay.dispatch` for that session in that window: the shell did not send them. **(verified, log and trace)**

**[F02] The 15:47:21 replay landed while the live turn was in tool work, and the session store dropped the replay and the turn's frames with it.** The deck's warnings, relayed into tugcast's log:

```
deck: replay_started in unexpected phase tool_work; dropping
deck: dropping turn_complete with no pendingTurn or activeMsgId  phase "waking"   (×5)
deck: replay_complete in unexpected phase waking; dropping
dev::ledger: a replayed frame opened a turn whose own replayed end was discarded — latch cleared
```

After this the store was in `waking` with no active message; the live turn's `AskUserQuestion` tool block and its text never rendered, the status bar's **Awaiting** came from the pending-ask store that had seen the ask, and the composer had no dialog to show. The WebSocket then reset without a closing handshake at 15:49:06 and the body reloaded cold at 15:49:16. **(verified, log)**

**[F03] Each replay re-emitted the finished `/compact` prompt as a pending row.** `pending_row_synthetic_emit` with journal id `4a1ae371…` at 15:45:29 and again at 15:47:21, for a turn that had completed at 15:45:09 (`turn_seen_journal_row_deleted`). That is the duplicated prompt the user saw under "Session compacted". **(verified, log)**

**[F04] Every arrangement body builds a session store for every session on the deck, and each store sends its own `request_replay`.** The shell sends a `bodyDeck: "arrangement"` card (Layout, Workspaces) a `card-context` carrying `bindings` for every card in every workspace (`body-shell.ts` `contextExtras`, `body-arrangement.ts` `projectArrangement`). The body page mirrors those into its own `cardSessionBindingStore` (`body-main.ts` `createCardFactsMirror`). `cardServicesStore._reconcile` in that page skips only cards in `bodyCardsStore`, which a body page does not populate, so it constructs a `CodeSessionStore` for each mirrored binding and `_construct` ends with `sendRequestReplay`. The user's deck held three Layout cards and three Workspaces cards across workspaces, so a session could be replayed by up to six pages that never show its transcript. `bodyFollows` cards (Arcs, devtools) mirror one binding the same way. **(verified, code; the count of live arrangement bodies at the time was not measured)**

**[F05] What makes an arrangement body re-request a replay is not established.** `_reconcile` constructs only for a binding it has not seen or whose `tugSessionId` changed. The shell resends `card-context` on every binding-store, title-store, identity or app-info change, and the mirror writes a binding only when its JSON differs. Nothing in the three windows before the replays shows a binding change. The user's observation — a prompt submitted in **another** Session card fires a replay here — is the best lead, and was not reproduced before bodies were turned off. Candidates to check: a `spawn.ack` rewriting a binding's `seatedSessionId`/`lineId` on a prompt; the store's own `REPLAY_BRACKET_DEADLINE_MS` and silence deadlines re-arming in a store that never sees `session_init` for a session it does not drive; `clearAll` in a body on a reconnect the shell did not log. **(not verified; this is the reproduction to run first)**

**[F06] The reducer treats a replay that arrives mid-turn as something to drop rather than defer.** `handleReplayStarted` refuses `replay_started` outside the phases it expects and logs; the frames that follow still arrive and the turn-complete handling discards them for lack of a pending turn. A replay is a rehydration of what is already on disk; dropping the live frames in favour of refusing it is backwards. **(verified, log; the code paths named from the warnings' sources, not re-read)**

**[F07] Five files are edited and unverified in the working tree at `1d6eb2290`.** Made during the diagnosis, before the user tabled the work; no type check and no test has been run on them:
- `tugdeck/src/lib/card-services-store.ts`, `tugdeck/src/body/body-main.ts`: `attachBody(cardId)` records the page's own card and `_servesCard` restricts construction to it; the shell's rule is unchanged.
- `tugdeck/src/lib/body-arrangement.ts`, `tugdeck/src/lib/body-facts-store.ts`, `tugdeck/src/lib/body-shell.ts`: the arrangement carries `activities` (each card's reported phase key), the shell fills it from `bodyFactsStore.activityOf` and resends only when some card's phase changes, the body mirrors it into a new `cardActivityElsewhere` store. Nothing reads that store yet: `useSessionPhase` still answers from `cardServicesStore`, which in a body now has no store for another card, so a phase dot in the Layout or Workspaces body would read `idle` for every other card until the hook is pointed at the mirror. **(verified, diff)**

**[F08] Earlier in the same session the user saw the same shape during the app-test baseline runs:** "I see progress coming through, then the card flashes, and then it's gone," twice. Those were not diagnosed at the time; they match [F02]'s signature (a replay dropped mid-turn, the live tool block gone with it). **(inference from the symptom; not verified against the log)**

---

## Decisions {#decisions}

**[B01] Cards and sessions come first; the app-test corpus cut waits.** `briefs/app-test-corpus-cut-brief.md` stands as written and resumes after this brief's work lands. Its slice 1 list (nine readings and benches to move out of the corpus) was presented and not yet approved; nothing in the corpus has moved.

**[B02] A page builds a session store only for a card it shows.** The shell builds for every bound card that is not a body; a body page builds for its own card and no other. A mirrored binding is a fact about another card, not a session to drive. This is [F07]'s first pair of edits, kept and verified rather than rewritten. The invariant to assert: in a body page, `cardServicesStore.getServices(x)` is `null` for every `x` but the page's card, whatever bindings the page mirrors.

**[B03] A replay never drops a live turn.** When `replay_started` arrives while a turn is in progress, the store either defers the bracket until the turn ends or applies it without disturbing the active turn; it never leaves `waking` with no active message and never discards `turn_complete`. Whichever is chosen, the live tool block and the pending ask survive. The 2026-10-16 log sequence in [F02] is the regression's fixture.

**[B04] A finished turn is never re-emitted as pending.** `pending_row_synthetic_emit` for a journal row the ledger has already seen complete ([F03]) is a defect in tugcode's replay or tugcast's merger, fixed at its source rather than hidden by the reducer's dedupe.

**[B05] The per-prompt trigger is reproduced before anything else is landed.** Bodies on, two Session cards, a Layout or Workspaces card open; submit a prompt in one card and watch the other's `request_replay.dispatched` in `tugcast.log`. The reproduction names the mechanism in [F05]; the fix for it rides with [B02] or is its own finding.

**[B06] Phases for other cards reach an arrangement body through its context, not through session stores.** [F07]'s second set of edits carries each card's reported phase in the arrangement. It is kept only once `useSessionPhase` (and the other readers in `use-session-phase.ts`) answer from the mirror in a body page; until then the Layout and Workspaces miniatures would show every other session idle. The shell resends on a phase change only, not on every telemetry tick.

**[B07] Every fix here has a guard the user can run.** A unit test over the stores for [B02] and [B06]; a reducer test replaying [F02]'s frame sequence for [B03]; an app-test only where the guarantee cannot be stated without the real app, and inside the 20 s budget of `briefs/app-test-corpus-cut-brief.md` [B02].

**[B08] Work lands on main in slices the user commits, with bodies off on the daily deck until [B02], [B03] and [B05] are done.** The user already set bodies off and relaunched; the switch goes back on only to verify, then stays on when the three hold.

---

## Open Questions {#open-questions}

- **What fires the replay on a prompt in another card** ([F05]). Settled by the reproduction in [B05], not by reading.
- **Defer or merge** for [B03]: holding a replay until the turn ends is simpler and keeps the live frames untouched; merging keeps a reload during a long turn honest. The reducer's existing bracket and prepend machinery decides which is cheaper.
- **Whether the WebSocket reset at 15:49:06 was the body being closed by the user or a consequence of the stuck store.** The user closed and reopened the card at about that time; the log cannot tell the two apart.

---

## Non-goals {#non-goals}

- **Reverting the per-card web views program.** Stages 1–5 stay joined; the switch is off on the daily deck as a stance, not a rollback.
- **Any app-test corpus change.** Moves, deletions and runner changes wait for `briefs/app-test-corpus-cut-brief.md`.
- **Deduping replays in tugcast or tugcode.** Fewer requesters ([B02]) is the fix; a server-side dedupe would hide the next page that over-requests.
- **Hiding the duplicated prompt in the reducer.** [B04] fixes the emit.

---

## Exit {#exit}

**An arc.** The first steps, in order: verify or redo [F07]'s `card-services-store` edit against the [B02] invariant with a unit test; reproduce [B05] with bodies on and name the trigger; make the reducer survive [F02]'s sequence ([B03]) with a test over the logged frames; fix the pending-row re-emit ([B04]); then point the phase hooks at the arrangement's `activities` ([B06]) so the Layout and Workspaces bodies show live dots again. Bodies go back on for the verification of each, and stay on when [B02], [B03] and [B05] hold.
