<!-- brief-skeleton v1 -->

# Workspace switch: the session hand-back

**Purpose:** Switching workspaces hides a Session card's body, which stops listening by design. When the card is shown again, three separate pieces of the wake-up path misreport what happened while it was away: a finished turn reads as working for half an hour, a mid-turn message is rendered twice, and tugcast clears a live turn's busy latch. The sessions themselves never stop.

---

## Purpose {#purpose}

On 2026-10-26 the user sent a prompt to session `knotty-rise`, queued a second message, and switched to another workspace. The turn finished in under two minutes. On returning about thirty-five minutes later the card still showed the session working. The user's report: "What was knotty-rise doing for *30 minutes*? If I click over to another workspace, we *can't just stop all sessions in the workspace I click away from!*" Then, on learning the work had finished: "the card failed to update to show me. This is not as bad... but it's *almost as bad*."

In the session that investigated, the user sent a mid-turn message, clicked away and back, and the message was rendered a second time: "My #u1.2 message got repeated as #u1.4 when I clicked away and then back to this workspace." The ask became a full audit of what happens to sessions on a workspace switch, with a sketch to understand and fix it.

---

## Evidence {#evidence}

**[F01] No session stops on a workspace switch.** The `tugcode` process for `knotty-rise` (pid 57340) and its `claude` child (pid 57342), both spawned at 19:53:30Z, were alive and idle at 20:33Z. The transcript's last event is the assistant's final text at 19:57:16Z, and the tugcast ledger consumed both pending-turn journal rows at 19:57:16Z (`turn_seen_journal_row_deleted`). **(verified)**

**[F02] The timeline of the knotty-rise card, from the release-main `tugcast.log` and `tugapp.log` for 2026-10-26.** **(verified)**

| Time (UTC) | Event |
|---|---|
| 19:55:22 | Prompt sent; pending-turn row inserted |
| 19:55:59 | Second message queued (absorbed mid-turn by Claude at 19:56:05). The workspace was hidden at this moment: the host's eviction fired at 20:10:59, and `BodyLifecycle.evictAfter` is 900 000 ms |
| 19:57:16 | Turn complete |
| ~20:01:35 | The hidden workspace's seven body sockets fell silent (last inbound frame); tugcast cut them at 20:04:33 to 20:04:40 for `HEARTBEAT_TIMEOUT` (180 s) |
| 20:07:46 | The bodies woke, reconnected as clients 52 to 58, re-bound their pages, and re-spawned in `resume` mode. The knotty-rise card's rebind sent `request_inflight`; tugcode answered `turn=finished` with 120 frames |
| 20:10:59 | Host evicted all seven bodies, cause `hidden` |
| 20:25:59 | Covers aged out; the cards had neither page nor picture |
| 20:31:05 | User returned. Bodies rebuilt, `reload_reason="launch"` replay with `turns=1`. The card's dot still read working |
| 20:31:37 | User opened a new card to ask what happened |

**[F03] The thirty minutes is a constant.** `WORKING_HORIZON_MS` in `tugdeck/src/lib/bodiless-facts-store.ts` is `30 * 60_000`: a bodiless "working" reading with no later sign of work falls to idle on its own after thirty minutes. The card was waiting on that horizon. **(verified by reading the code)**

**[F04] A hidden body goes dormant after 60 s and empties its subscription.** `DORMANT_AFTER_MS` in `tugdeck/src/lib/body-visibility-store.ts` is 60 000. On `sleep`, `installBodyDormancy` in `tugdeck/src/body/body-dormancy.ts` saves the bag, tells the session it sleeps, stills loops, lids content, and re-scopes the subscription to nothing, so tugcast sends the page nothing of any session. Dormancy is sticky until a catch-up bracket closes. **(verified)**

**[F05] The shell's fallback for a card whose body is not listening starts from the body's frozen facts and ends a turn only on a later ledger stamp, a non-live row, or the horizon.** `enterBodiless` takes the row's current `last_used_at` as the mark; `onLedger` ends the reading only when a later `last_used_at` arrives or the row leaves `live`. A body evicted after its turn already ended, with facts frozen at "working" and the stamp already behind the mark, reads working until the horizon. **(verified by reading the code)**

**[F06] A sleeping body's rebind asks for its in-flight turn with nothing to hear the answer.** The rebind branch in `tugdeck/src/lib/session-control-actions.ts` sends `request_inflight` whenever the store's phase is not `idle` or `errored`, with no check of dormancy. At 20:07:50 the dormant knotty-rise body did exactly this and the 120-frame answer went to an empty subscription. **(verified: code and log)**

**[F07] Why the ledger stamp at 19:57:16 did not retire the dormant card's reading during the dormant window is not proven.** `record_turn` in `tugrust/crates/tugcast/src/feeds/agent_supervisor/recorder.rs` stamps `last_used_at` and broadcasts `session_updated`, but logs only at debug, and the row's `last_used_at` was overwritten by `set_turn_count` at the 20:31:05 replay. The chain in [F02], [F05] and [F06] accounts for the observed state from 20:10:59 onward without this link; the window 19:56:59 to 20:10:59 needs a harness reproduction. **(inference; a reproduction with shortened delays would confirm)**

**[F08] A mid-turn message is rendered twice after a catch-up.** In the investigating session, the user's mid-turn message was journaled as a pending-turn row at 20:34:21 (len 152) and absorbed by Claude at 20:34:31 (`absorbed_mid_turn`). On the body's reveal at 20:38:28 a `catch-up` replay ran, and tugcode logged `pending_row_synthetic_emit` for that row. `injectPendingRowSynthetics` in `tugcode/src/replay-runner.ts` decides to re-emit by counting matching user-text lines in the JSONL; a message absorbed mid-turn never appears there as a user line, so every catch-up during that turn re-emits it. The synthetic `add_user_message` carries no id the live copy shares, so the reducer appends a new entry. **(verified: code and log)**

**[F09] A catch-up during a live turn clears tugcast's busy latch.** `clear_replay_residue` in `tugrust/crates/tugcast/src/feeds/agent_supervisor/ledger_entry.rs` forces `turn_active` false at the outermost bracket's close, including a latch the live turn set before the bracket opened. At 20:38:28.661 it warned `replay_residue_cleared` with `kind=user_message` for the investigating session, whose turn ran until the user's interrupt at 20:39:12. Its own comment promises the entry reads "exactly as it read before the bracket opened"; the implementation forces quiet instead. **(verified: code and log)**

**[F10] Dormancy rides a timer inside a page WebKit may freeze.** The 60 s clock runs in the body page. Here it fired, but [F02] shows WebKit suspending the hidden views' JS a few minutes after hiding, and tugcast's heartbeat rule (`router.rs`) then cuts the sockets as dead wires. Nothing orders the dormancy clock before the suspension. The host, which parks the workspace, knows the hide time with certainty. **(verified: code and log; the ordering hazard is inference)**

**[F11] The host hides bodies by opacity and covers, never `isHidden`, and evicts after fifteen minutes.** `tugapp/Sources/BodyViewController.swift` and `tugapp/Sources/BodyLifecycle.swift`. A hidden body keeps its page until `evictAfter`; pressure evicts sooner. **(verified)**

---

## Decisions {#decisions}

**[B01] Every user submission carries one identity from the composer to every copy of it.** The deck mints an id when it sends a `user_message`; the same id goes on the pending-turn journal row and on any synthetic `add_user_message` tugcode emits from that row, and the reducer dedupes by it. Text-count matching against the JSONL in `injectPendingRowSynthetics` is retired. This is the fix for [F08]; text matching can never tell an absorbed mid-turn message from a lost one.

**[B02] A catch-up ask names the open turn it holds, and tugcode does not synthesize a pending row for it.** The ask already carries `heldTurns`. With [B01] the dedupe is belt and braces; without it a second copy would still cost a render and a scroll.

**[B03] A replay bracket's close restores the latch it found, never forces quiet.** At the outermost bracket's open, snapshot `turn_active` and `turn_opener`; at close, restore them and warn only if a replayed frame moved them. The [B01] invariant the comment states is kept; the implementation that violated it for a live turn ([F09]) is what changes.

**[B04] Asleep means silent.** A dormant body does not reconnect and does not ask. The rebind path checks the body's `asleep` state before `request_inflight`, and the one catch-up ask on reveal goes out after the subscription is re-scoped, which is the ordering `body-dormancy.ts` already intends. Fixes [F06].

**[B05] The host declares a body hidden; the page does not infer it from a timer.** The host tells tugcast directly when a workspace parks, and tugcast drops the body's subscription and marks the card dormant. A hidden socket is then quiet on purpose and tugcast stops cutting it as a dead wire. Removes the ordering hazard in [F10] and makes the dormancy moment a fact rather than a race.

**[B06] A card's phase has one source: tugcast's per-session turn latch.** Expose `turn_active` on the session row that `session_updated` already pushes, and have the bodiless reading read it directly instead of inferring a turn's end from stamps and rate samples. The thirty-minute horizon stays as a safety net nobody reaches. This makes [F07] moot: whether the stamp landed in the dormant window no longer decides what the dot shows.

**[B07] Harness coverage lands with the fixes, under shortened delays.** Three app-tests: hide a workspace mid-turn and assert one user message after reveal; let a turn end while the card is hidden and assert the dot goes idle within seconds; catch up mid-turn and assert the busy latch holds until the real end. Each is a file under 20 s with `@covers` lines.

---

## Open Questions {#open-questions}

- Whether the ledger stamp at a turn's end reaches the shell's bodiless reading while the body is dormant ([F07]). [B06] removes the dependence, but the reproduction should still be run once so the stamp path is either confirmed or recorded as a second defect.

---

## Non-goals {#non-goals}

- **Keeping hidden bodies awake.** Dormancy, eviction and covers are the right design; a 500-turn body sits at about 550 MB resident. The work fixes the hand-back, not the sleep.
- **Stopping or pausing sessions on a switch.** Nothing does this today and nothing will; the user's premise that sessions stop was the symptom of [F03], not a mechanism.
- **Tuning the horizon or the heartbeat timeout.** Shortening `WORKING_HORIZON_MS` would make the wrong reading expire sooner; it would still be wrong. The timeouts stay; [B05] and [B06] make them irrelevant to what the card shows.
- **A second path for lost ledger pushes.** No retry or polling for `session_updated`; [B06] puts the truth on the row the shell already receives, and the no-polling rule stands.

---

## Exit {#exit}

An arc. The shape that falls out of the decisions, in the order they must land:

1. The submission id ([B01]) across deck, journal row and tugcode, with the reducer's dedupe and the catch-up window naming its held turn ([B02]). This is the user-visible duplicate and goes first.
2. Bracket close restores the latch ([B03]), with a unit test in `ledger_entry.rs` over a live turn spanning a bracket.
3. The sleeping body's silence ([B04]) and the host-declared hide ([B05]) in tugapp, tugcast and the body page.
4. `turn_active` on the session row and the bodiless reading over it ([B06]).
5. The three app-tests ([B07]), and the one reproduction that settles the open question.
