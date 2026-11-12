<!-- brief-skeleton v1 -->

# tugcast Refuses a Body's Spawn for Another Card

**Purpose:** A body page may act for its own card only ([L38]), and today only the client holds that rule. tugcast accepts a `spawn_session` for any card from any page, so the next page that breaks the rule resumes other cards' sessions again and is found by reading a log.

---

## Purpose {#purpose}

On 2026-11-12 the Cards card's body resumed every Session card in its workspace on reconnect. The shell took the acks, built stores for cards no page drew, and a parked workspace's session panes stood blank for the rest of the run (`briefs/shell-held-session-binding-brief.md`). The arc that fixed it (`28b4c9fe4`) stopped that one sender in `restoreSessions`, made the shell's answer to such an ack harmless, and made tugcast name the sender in its log.

What it left is that the server still does whatever a page asks. The audit of that arc named this as the one weakness worth its own work: the rule is enforced where it was broken, and nowhere a second offender would be stopped.

---

## Evidence {#evidence}

**[F01] tugcast reaches the spawn with the sender's identity in hand.** `do_spawn_session` (`tugrust/crates/tugcast/src/feeds/agent_supervisor/spawn.rs`) takes `client_id` and, since `28b4c9fe4`, reads the sender's `PageRecord` through `PageRegistry::record` to log `client_role`, `client_card` and `client_page` on `spawn.supervisor_recv`. The record carries `role` and `card_id`. **(verified)**

**[F02] Nothing compares the two.** The only caller is the `spawn_session` arm of `handle_control` (`control/session.rs`), which passes the parsed `card_id` and the `client_id` straight through. No path refuses a spawn on who sent it. **(verified)**

**[F03] The legitimate senders are known.** Read from the client: a body spawns for its own card (`body-intent.ts`, `reassertOnReconnect` in `body-main.ts`, the Session card's own `/clear` and directory change); the shell spawns for any card it has not handed off, which without body views is every card. On the fixed build, tugcast logged 13 spawns in the hours after launch, every one `client_role=body` with `client_card` equal to `card_id`. **(verified)**

**[F04] Every spawn ack still goes to every page.** The shell's `handOffUnaskedAck` exists because of it. That broadcast is how the shell mirrors bodies' bindings, so it is load-bearing and not a defect in itself. **(verified)**

**[F05] A spare page has no card until it takes one.** `PageRecord.card_id` is `None` for a spare and `bound_from_spare` marks one that has taken its card. On reconnect a spare sends `page_bind` before its reassert on the same socket (`body-main.ts`). Whether a spare's first spawn after taking a card always follows a `page_bind` tugcast has already applied was not read out. **(not established)**

---

## Decisions {#decisions}

**[B01] tugcast refuses a `spawn_session` from a body page whose card is not the spawn's `card_id`.** The refusal is a `ControlError` the sender receives, before the ledger or any workspace is touched, and it is logged at `warn` with the same four sender fields. A refusal rather than a warning because the harm is done by the spawn itself: a logged violation still resumes the session and still broadcasts the ack. The client-side narrowing in `restoreSessions` stays; this is the second lock on the same door, on the side that cannot be bypassed by a new caller.

**[B02] The shell, a tool client, and an unregistered client are not restricted.** The shell acts for every card that is not a body's ([L38]), the harness and `tugtool` drive spawns as tools, and an unregistered sender is an older or foreign client the guard has no facts about. The guard is about one rule, a body and its own card, and widening it is a different decision.

**[B03] The guard covers `spawn_session` only.** It is the control that starts or re-holds a session and the one that did the damage. The other card-addressed controls are read for the same hole in this arc, and any that a body could misuse the same way is named in the arc's report; extending the guard to them is decided there, with the evidence, not assumed here.

**[B04] A Rust unit test holds each row of the table:** body for its own card passes, body for another card is refused with nothing recorded, shell and tool pass, unregistered passes. The existing client tests (`session-restore-body-scope.test.ts`) are untouched.

---

## Open Questions {#open-questions}

- **Is a body page with no card refused?** A spare that has not taken a card should have nothing to spawn, so refusing is the consistent answer, but [F05] is not established: if a spare's first spawn can reach tugcast ahead of its `page_bind`, refusing would break a legitimate launch. Reading the spare's take path in `body-main.ts` against the order tugcast applies `page_bind` settles it.

---

## Non-goals {#non-goals}

- **Narrowing the ack broadcast.** The shell mirrors bindings from it ([F04]); changing who hears an ack is a redesign of that mirror, not a guard.
- **Removing the client-side fixes.** `handOffUnaskedAck` and the body narrowing stay. With the guard in place an unasked ack for a pageless card should no longer occur, but the shell's answer to one costs nothing and covers a shell or tool sender the guard admits.
- **Cards on no deck.** An ack for a card no workspace holds still builds shell stores. No sender of such acks is known since the fix; if the log shows one, it is its own finding.

---

## Exit {#exit}

**An arc.** First steps:

1. Settle the spare question by reading the take path ([F05]).
2. Add the comparison at the top of `do_spawn_session`, beside the sender lookup that is already there, with its `ControlError` and `warn` line ([B01], [B02]).
3. Unit tests for the table ([B04]); run the reconnect app-tests `at0335` and `at0742` as the verdict, since they exercise every body's reassert.
4. Read the other card-addressed controls for the same hole and report ([B03]).
