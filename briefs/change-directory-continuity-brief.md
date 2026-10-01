# Keeping a card continuous across a directory change

**Purpose:** `/cd` moves a Session card into another directory and carries its conversation. But it drops the card's prompt history, and the card can flash empty while it moves.

---

## Purpose {#purpose}

The directory-change arc (`/cd`, `/change-directory`) landed, and the user tested it. Their report, in their words:

1. "Major problem. Prompt history is lost when I change directories. This must be preserved."
2. "There can be a *horrid flash* when the change directory operation happens. This *must not* happen."

The move is meant to be invisible except for the `Directory changed` divider: the same card, the same conversation, a new directory. These two defects break that promise.

---

## Evidence {#evidence}

**[F01] A move puts the card on a new tug session.** The move is a swap rather than a migration. The deck spawns a new tug session in the target directory with `relocate_from` naming the current one, and `spawn_session_ok` re-binds the card to the new id. tugcast closes the old session after the ack (`do_spawn_session` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`). **(verified, read from the code)**

**[F02] Up-arrow history is keyed by tug session id.** The composer pushes and reads history under `snapRef.current.tugSessionId` (`tugdeck/src/components/tugways/tug-prompt-entry.tsx`), through `PromptHistoryStore.createProvider` / `createRouteProvider` (`tugdeck/src/lib/prompt-history-store.ts`). After a move the composer asks under the new id. **(verified, read from the code)**

**[F03] The server reads history through a lineage, so a fork edge would carry it.** `prompt_lineage::chain_for` (`tugrust/crates/tugcast/src/prompt_lineage.rs`) resolves the asking id through `SessionLedger::resume_lineage_chain`, which follows `forked_from_session_id`, and records the chain in `prompt_history.db`'s `session_lineage`. A moved session's row is forked from its parent by the `relocate` edge. Once that edge exists, a read under the new id reaches the parent's prompts. **(verified, read from the code)**

**[F04] The fork edge is written after the card has already asked.** `set_fork_provenance` runs in the bridge's `session_init` handling (`tugrust/crates/tugcast/src/feeds/agent_bridge.rs`). That happens when tugcode announces the `relocate` segment, after tugcode has started up, and `spawn_session_ok` is sent before tugcode starts. The rebind constructs the new card services, and the composer's first history fetch for the new id goes out with them. The server most likely answers with the new id alone. **(the ordering is read from the code; that the first fetch actually loses this race is inferred. A reload restoring the history would confirm it.)**

**[F05] The deck never re-fetches a session's history.** `PromptHistoryStore.loadSession` adds the id to `_loadedSessions` after the first page, and nothing removes it. An empty first answer therefore stays empty until the deck reloads. **(verified, read from the code)**

**[F06] The card's transcript empties the instant the binding changes.** `CardServicesStore._reconcile` (`tugdeck/src/lib/card-services-store.ts`) disposes the old bag and constructs a fresh one, with an empty `CodeSessionStore`, when a card's `tugSessionId` changes. It then sends `request_replay`. The replay is queued while tugcode starts, so the transcript stays empty for that time. **(verified, read from the code)**

**[F07] Nothing covers the gap.** The cold-restore banner opens only for `sessionMode === "resume"` (`notifyResumeBindingLanded`), and a move spawns `"new"`. **(verified, read from the code)**

**[F08] The flash is probably the empty interval.** The user sees the conversation, then an empty card for as long as tugcode takes to start, then the whole replay arriving at once. **(inferred from [F06] and [F07]; not yet sampled. A per-frame recorder armed before `/cd` would confirm it.)**

---

## Decisions {#decisions}

**[B01] tugcast records the prompt lineage before it acknowledges a move.** In `do_spawn_session`, whenever `relocate_from` is present, tugcast writes `prompt_history.db`'s `session_lineage` for the new id: the old session's resolved chain (`chain_for`) followed by the new id. It does this before `spawn_session_ok` is sent. The race in [F04] then cannot happen: the card's first request comes after the lineage exists, so the deck needs no change and the [F05] cache is harmless. The lineage is recorded even when the parent had no conversation to carry ([P07] of the change-project-dir plan): the card's typed history belongs to the card, and `/cd` itself is recorded in it. A second move before any turn gets the whole chain because each move records the full chain. This is the durable fix: a relaunch already reads through the same table.

**[B02] A move swaps the transcript only when the new one is ready.** On a rebind caused by a directory change, `CardServicesStore` builds the new bag but keeps publishing the old one, so the card goes on showing the old transcript. The replay fills the new store while it is not rendered. When that replay completes, the store publishes the new bag and disposes the old one in a single notification. The card goes straight from the pre-move transcript to the post-move transcript with its `Directory changed` divider. No frame shows an empty card. The card itself does not keep the transcript across the move; the replay still draws it, which keeps [P04]'s single code path.

**[B03] The swap always ends.** It happens on the first of three things: the new store's replay completes, the new session reports an error, or a time limit expires. A move that goes wrong must never leave a card showing a session that tugcast has already closed.

**[B04] While the swap waits, the old store accepts no sends.** The old session is already closed, so a prompt submitted during the wait is queued. The existing hand-over of stranded sends (`drainQueuedSends` / `seedQueuedSends`) delivers it to the new store.

**[B05] Only the transcript waits.** The binding still re-seats at the ack, so the title, the workspace key, the Changes shade and the shell follow the move immediately. Holding those back would buy nothing, because none of them empties.

**[B06] The swap-when-ready behavior is for moves only.** `/clear` is meant to empty the card, and `/resume` has its own banner. Both keep today's immediate swap.

**[B07] Each fix is proven by a test that can see its failure.** History gets a tugcast test showing that a page read under the new id, before tugcode has started, returns the parent's prompts. The flash gets an app-test that arms a per-frame recorder before `/cd` is sent and fails on any frame where the card's transcript lacks the pre-move conversation or is empty. That test is also run with the swap fix reverted under `file probe`, to show it catches the flash. A final-state assertion is not enough here, because it passes with the flash present.

---

## Open Questions {#open-questions}

- **Can the no-flash app-test run without `TUG_REAL_CLAUDE=1`?** The move needs a real claude to start, because claude performs the fork, but the test sends no prompt. If starting claude without a turn costs nothing and needs no credentials the harness lacks, the test can run in the ordinary selection. Otherwise it is gated like `at0655`. Running it once in the harness settles this.
- **Does the old store stay quiet after tugcast closes the old session?** [B02] keeps that store on screen during the wait. If the close sends frames that make it show a closed or errored state, the wait must also suppress that. Reading the close path or watching one move settles this.
- **What should the time limit in [B03] be?** It must exceed a normal tugcode start plus a replay. A number measured during implementation settles this.

---

## Non-goals {#non-goals}

- **Re-keying stored prompts to the new session.** Each row records the session that wrote it, and that fact is worth keeping. The ledger is read through a lineage precisely so nothing is re-keyed (`prompt_ledger.rs` header).
- **A deck-side history alias as the fix.** Having `PromptHistoryStore` point the new id at the old id's window would fix the live card, but it duplicates what the server's lineage already does, and it does nothing for a second deck or a relaunch. [B01] fixes the cause.
- **Making the deck re-fetch history to paper over the race.** A re-fetch on a later signal would still show empty history for a moment, and it adds a second fetch path to a store that has none.
- **The deck seeding the new transcript from the old one.** Replay is the single source of the moved transcript ([P04]). Seeding from the deck and then replaying would duplicate turns, or need reconciliation.
- **A loading banner over the gap.** The user asked for no flash, not for a nicer one.
- **Changing `/clear` or `/resume`.** See [B06].

---

## Exit {#exit}

**An arc.** It has two independent halves, and the history half is smaller and the more urgent, so it goes first:

1. **History:** tugcast records the prompt lineage in `do_spawn_session` before the ack ([B01]), with its Rust test ([B07]). The supervisor needs a handle on the prompt ledger, which today reaches only the HTTP API layer.
2. **Flash:** first sample a real move to confirm [F08]. Then add the held swap in `CardServicesStore` with its three exits ([B02], [B03]), the hold on sends ([B04]), and the quiet old store (second open question). The per-frame app-test closes it, proven red against the reverted swap ([B07]).
