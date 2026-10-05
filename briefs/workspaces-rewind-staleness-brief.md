<!-- brief-skeleton v1 -->

# Workspaces Goes Stale After a Rewind

**Purpose:** After a rewind in a Session card, the Workspaces sidebar card goes on showing the session as it was before the rewind. The row has to follow the conversation the card is actually continuing.

---

## Purpose {#purpose}

"When I rewind in a session card, the Workspaces sidebar card has to get the memo."

A rewind changes what the conversation is: turns are dropped, and the card continues from an earlier message. The Workspaces row for that card keeps showing the pre-rewind turn count, last prompt, last-used time and synopsis, and it never catches up: later turns on the rewound conversation do not move it either.

---

## Evidence {#evidence}

All findings below were read out of the code; none was reproduced in the running app.

**[F01] The Workspaces row reads the ledger row of the card's original segment id.** `CardsSessionRow` (`tugdeck/src/components/cards/cards-session-cell.tsx:87`) passes `binding.tugSessionId` (`tugdeck/src/components/cards/cards-data-source.ts:645`, via `cards-card.tsx:623`) to `SessionIdentityRow` (`tugdeck/src/components/tugways/session-identity-row.tsx:913`), which reads `useSessionLedgerRow(sessionId, projectDir)` (`:957`). That store (`tugdeck/src/lib/session-ledger-store.ts:593`) is keyed by claude segment id and patched by `session_updated` pushes (`:391-398`, `patchRow` `:436`). The row uses `turn_count`, `file_size` and `last_used_at` for the rest sentence (`:1147-1151`), and `last_user_prompt` as a description fallback (`:280-286`, `:1046-1053`). **(verified)**

**[F02] A rewind fork writes everything after it to a new segment id, and pushes an update only for that id.** The forking rewind (`tugcode/src/session.ts` ~`8728-8772`, `applyConversationRewind`) mints a new id, writes a truncated copy of the JSONL under it, leaves the original file intact, and emits `session_segment{kind:"rewind"}` and a synthetic `session_init`. tugcast records the new row against the card's line (`tugrust/crates/tugcast/src/feeds/agent_bridge.rs:1879-1966`, `:2200`, provenance at `:2244-2250`) and pushes `session_updated` for the **new** id, then `session_line_seated`. Every later `record_turn` and `record_user_prompt` writes under the new id (`agent_bridge.rs:2580-2586`, `:3436`). **(verified)**

**[F03] The deck already learns the seated segment but nothing reads it for this row.** `session_line_seated` is handled at `tugdeck/src/action-dispatch.ts:2043` by `cardSessionBindingStore.setSeatedSegment(cardId, sessionId, lineId)` (`tugdeck/src/lib/card-session-binding-store.ts:169`). `binding.tugSessionId` does not change, and the only reader of the seated segment is `arc-session-index.ts:296` via `seatedSegmentForSession` (`card-session-binding-store.ts:319`). **(verified)**

**[F04] So after a fork rewind, these facts on the row are frozen at their pre-rewind values:** `turn_count` (the original segment's untruncated JSONL), `last_used_at`, the `last_user_prompt` fallback (the prompt that was rewound away), `file_size`, and the created time. Name, callsign and arc progress live on the line and are not stale. The live rungs (Observer current line, posts, digest beats) are keyed by the card's session scope and are not affected. This follows from [F01]–[F03]; it was not observed in the app.

**[F05] The synopsis is line-keyed, so it carries over the rewind, but it still describes the work that was rewound away.** It is written by the Observer (`tugrust/crates/tugcast/src/feeds/observer.rs:794` `write_synopsis`, push at `:931`), and the Observer wakes on digest, turn end, submission and session end. Nothing wakes it on a rewind, so the synopsis stays wrong until the next of those. **(verified from the wake sites; the lag itself was not observed)**

**[F06] The in-place rewind pushes nothing either.** `applyConversationRewind(promptUuid, false)`, used by prompt retraction (`applyPromptRetraction`, `session.ts` ~`8840`), rewrites the live JSONL under the same id and emits no segment frame. Nothing pushes a corrected `session_updated` until the next turn completes or a replay sets the turn count (`agent_supervisor.rs:1376`, `:1395`). **(verified)**

**[F07] A line's turn count double-counts what a rewind fork kept.** `line_turn_count` (`tugrust/crates/tugcast/src/session_ledger.rs:4380`) is `SUM(turn_count)` over every segment of the line, and `list_lines_with_card` (`:4243`) uses it. A rewind fork's JSONL is a prefix copy of its parent's, so the turns before the fork point are counted once in the parent and again in the fork. Summing is correct for rotation segments, which do not copy history. A rewind edge is told apart from a rotation edge by `fork_point IS NOT NULL` (`session_ledger.rs:1902-1907`). **(read from the query; the inflated number was not observed)**

---

## Decisions {#decisions}

**[B01] Rewind stays a one-way operation.** A redoable rewind (a soft cut that branches only on the next send) was weighed and abandoned. This work makes the existing behaviour visible correctly and changes nothing about what a rewind does.

**[B02] The Workspaces row reads the line's seated segment, not the card's original segment id.** The deck already holds the seated segment ([F03]), and every post-rewind write lands on it ([F02]), so reading it makes the turn count, last-used time and last prompt correct without any new wire traffic. `binding.tugSessionId` stays the card's address; only the ledger-row lookup the row's facts come from moves. Fall back to `tugSessionId` when no segment has been seated.

**[B03] Every rewind, forking or in place, ends with a `session_updated` for the segment the card now continues.** For a fork this push already exists ([F02]) and [B02] makes the row hear it. For an in-place rewind ([F06]), the row has to be re-read and pushed once the truncated file is in place, so the turn count and last prompt drop at the moment of the rewind rather than at the next turn.

**[B04] A rewind wakes the Observer, so the synopsis is rewritten for the conversation that is left.** A synopsis describing rewound-away work is the most visible stale fact on the row ([F05]). The synopsis is written by the Observer and nowhere else, so the fix is a wake, not a second writer.

**[B05] A line's turn count counts each turn once.** A rewind fork contributes only the turns it adds beyond its fork point; rotation segments are still summed whole. Either subtracting the turns a rewind segment inherited, or counting the tip of each rewind chain instead of every segment, meets this. The choice between them belongs to whoever writes the query.

---

## Open Questions {#open-questions}

- **Which row shows the turn count?** The rest sentence uses the segment row's `turn_count` ([F01]), and the picker uses the line's sum ([F07]). After [B02] the Workspaces row shows the seated segment's count, which for a rewind fork already includes the turns it kept. The two agree if the segment is the line's only one, and differ for a rotated (arc) line. Whether Workspaces should show the line's total instead is a product call, and the answer decides whether [B02] alone is enough for the count. Settle it by looking at an arc line's row before and after the change.

---

## Non-goals {#non-goals}

- **Undo or redo of a rewind.** Considered and rejected in [B01]. Keeping the dropped tail, deferring the fork to the next send, and snapshotting files for a code redo were all on the table. The conversation half was cheap; restoring files is not, because `rewind_files` has no inverse. The decision was to leave rewind one-way rather than ship half of it.
- **Changing how a rewind forks.** The truncated-copy fork, the segment frame and the ledger provenance all stay as they are.
- **Code rewind.** `rewind_files` and the "Code + conversation" scope are unchanged.
- **Rebinding the card to the new segment.** The card's `tugSessionId` stays its address, as [D167] intends. Only the row's lookup moves ([B02]).

---

## Exit {#exit}

An arc. The first steps are:

1. The deck change in [B02], so the row reads the seated segment. This is the one users see.
2. The in-place push in [B03] and the rewind wake in [B04], both in tugcode and tugcast.
3. The turn-count query in [B05], with a ledger test covering a line that has both a rewind fork and a rotation.

An app-test should rewind a three-turn session and assert that the Workspaces row's turn count and last prompt drop. `tests/app-test/at0097-rewind-sheet.test.ts` already drives the rewind sheet and is the closest starting point.
