# The load bar counts one segment against a whole line

**Purpose:** On a rotated card the transcript's load bar can read **18 of 4 · all loaded** — more turns displayed than the session is said to contain, and a fraction over one. The numerator counts every turn the card has loaded across an arc's segments; the denominator is one segment's file. This brief settles which population the fraction is over, and how the two numbers stop being counted over different things.

---

## Purpose {#purpose}

The user's words, on being told the display was possible:

> **Bizarre**. We can't let this stand.

They are right, and the reason it is worth a brief rather than a clamp is that the bar is a *claim about completeness*: `X of Y · all loaded` is how a reader decides whether the scroll above is the whole story. A fraction over one does not just look wrong, it means the surface that answers "is anything missing?" is answering from a population that is not the one on screen.

---

## Evidence {#evidence}

The bar is `tugdeck/src/components/tugways/cards/session-load-control-bar.tsx` and its pure half `session-load-control-bar-state.ts`; the stamp is `tugrust/crates/tugcast/src/feeds/agent_bridge.rs`; the lineage walk is `collectLineagePrefix` in `tugcode/src/session.ts`; the window resolver is `resolveWindow` in `tugcode/src/replay.ts`.

**[F01] The two numbers are counted over different populations.** *X* is `countClaudeTurns(codeSessionStore.getSnapshot().transcript)` (`session-load-control-bar.tsx:424`) — every non-ink turn the card has loaded, whatever file it came from. *Y* is `totalTurns` off `replay_complete`, kept on `state.replayWindow` by `handleReplayComplete` and passed through `deriveLoadStatus`. Nothing reconciles them; they agree today only because a card has historically replayed exactly one file. **(verified)**

**[F02] `totalTurns` is one segment's count, and tugcast makes sure of it.** On every `replay_complete` the bridge reads `engine_turn_count(claude_session_id, project_dir)` — the turn engine over the **tip's** JSONL, the single count authority ([P08]/[Q01]) — compares tugcode's wire value against it, logs `contract_breach.replay_total_turns` on a mismatch with "engine wins", and re-stamps the frame with the engine's number. It also writes that number to the tip's ledger row via `set_turn_count`. So *Y* is a segment count by construction: summing inside tugcode would be overwritten and would log a breach on the way. **(verified)**

**[F03] A lineage replay puts several segments' turns in one transcript.** `collectLineagePrefix` translates each ancestor of a rotated line and emits its frames inside the one `replay_started`/`replay_complete` bracket, so ancestor turns commit as ordinary Claude turns and *X* counts them. On the `eager-wrap` line — three segments of 1, 13, and 4 turns — that is 18 against a stamped 4. **(the prefix and the stamp are verified in code and in `tugcast.log.2026-09-05`, where the 01:03 relaunch restore logged `lineage_prefix sessions=3 frames=1641`; the resulting bar was not observed on screen)**

**[F04] This is live today on the relaunch path.** The lineage has been sent on relaunch since `rebind_from_ledger` fills the entry's claude id before any client asks, so any relaunch of a card whose line has rotated already shows the wrong denominator. It does not wait on the resume-sheet seat fix (`notes/arc-notes-restore-seat-brief.md`), and it can be reproduced without it: relaunch onto a rotated arc card and read the bar. **(inferred from [F02]/[F03] plus the log; one relaunch confirms or kills it)**

**[F05] Ancestors are replayed whole, so `hasOlder` is already right.** `collectLineagePrefix` passes no `window` to `translateJsonlSession`; only the tip is windowed. The only unloaded turns in a lineage restore are therefore the tip's older ones — exactly what `firstLoadedTurnIndex > 0` reports. **(verified)**

**[F06] `firstLoadedTurnIndex` is a tip-coordinate index and paging depends on it.** `loadPrevious` (`code-session-store.ts:1151`) sends `turnRange: [first − N, first]`, which `resolveWindow` resolves against the tip's turn list alone; `deriveLoadStatus` uses the same number for `hasOlder` and to clamp the *Load N more* step to what remains. All three are correct as they stand, and all three break if the index is shifted into line coordinates to "match" a line-wide total. **(verified)**

**[F07] The line's total already exists and the card already shows it.** `SessionLedger::line_turn_count` (`session_ledger.rs:4271`) sums `turn_count` across a line's segments and is what the ledger reports when it lists lines (`session_ledger.rs:4197`); the masthead's rest sentence renders it. The screenshot's header reads *18 turns* over a bar reading *4 of 4* — 1 + 13 + 4 — so the two numbers on one card are already the line's and the segment's. **(verified)**

**[F08] The transient is invisible.** `deriveControlBarState` gives the strip to the loading display whenever a replay is in flight, so the window between the prefix committing and `replay_complete` landing never renders a fraction. Whatever is decided here only has to be right at rest. **(verified)**

**[F09] `engine_turn_count` is cached per file.** It stats the JSONL and serves `external_scan_cache` when `(file_size, file_mtime)` still match, running the engine only on a miss. Summing it over a handful of segments at `replay_complete` costs a stat each in the common case. **(verified)**

**[F10] Nothing pins the bar under a lineage.** `session-load-control-bar-state.test.ts` covers the pure math with single-session numbers; no Rust or app-test asserts what `replay_complete` carries for a multi-segment replay. **(verified)**

---

## Decisions {#decisions}

**[B01] *Y* is counted over exactly the segments the replay walked.** Not "the tip" and not "the line" as an abstraction: the bridge sums `engine_turn_count` over the lineage the request actually carried, which is the list `replay_lineage` already built. This is the rule that makes the fraction correct by construction rather than by coincidence — *X* counts the transcript the replay produced, *Y* counts the files that produced it, so the two are two readings of one decision and cannot drift. It also degrades identically at both ends: an ancestor whose JSONL is unreadable contributes a divider and no turns to the deck, and `None` → 0 to the sum. A replay with no lineage sums one file and the frame stays byte-identical to today's.

**[B02] The walked list is remembered, not recomputed.** `do_request_replay` computes the lineage; it records it on the ledger entry, and the `replay_complete` stamp reads it back. Recomputing the chain at stamp time would usually agree, but "what this replay walked" is a fact about a request, and reading it back is what keeps the guarantee in [B01] a construction rather than a hope. An entry with no remembered lineage — every card that is not an arc, and any replay that predates the field — sums the tip alone, which is today's behaviour exactly.

**[B03] `firstLoadedTurnIndex`, `hasOlder`, and the load step do not move.** They are already correct for the reason [F05] gives, and [F06] is what they would cost if they were "fixed" to match the new denominator: load-previous would page the wrong turns. The index stays the count of the **tip's** unloaded turns, which is precisely what a load-previous can fetch. The only field whose meaning changes is `totalTurns`.

**[B04] The tip's ledger row keeps the tip's own count.** The same block writes `set_turn_count(claude_session_id, engine_total)`, and `line_turn_count` sums those rows ([F07]). Writing the lineage sum there would double-count the line and set the masthead climbing on every restore. The sum goes on the outgoing frame and nowhere else.

**[B05] The contract-breach check stays tip-against-tip.** Its value is that it catches tugcode and the engine disagreeing about one file; comparing tugcode's tip total against a lineage sum would fire on every arc restore and mean nothing. Compare on the tip, then add the ancestors to what is stamped.

**[B06] The pins go where the numbers are decided.** A bridge test that a `replay_complete` under a remembered three-segment lineage carries the summed total while the tip's row still records the tip's own count ([B01]/[B04]), and that a no-lineage replay is byte-identical ([B01]). A pure test on `deriveLoadStatus` for the two shapes that matter: everything loaded (`18 of 18`, no older) and a windowed tip over whole ancestors (`39 of 54`, older present, step clamped to the tip's 15). No app-test — the defect is arithmetic over a frame, and the bar's rendering of a `LoadStatus` is already covered.

---

## Open Questions {#open-questions}

- **Does it read *18 of 4* today, or something else?** [F04] says one relaunch onto a rotated arc card settles it, and that observation should be the plan's first act — not because the mechanism is in doubt, but because the exact numbers on screen are the thing being fixed and nobody has yet looked at them.

---

## Non-goals {#non-goals}

- **Making *Y* the line's total unconditionally.** `line_turn_count` is right there and is tempting, but it would lie in exactly the case that produced this brief: a rotated line whose replay carried no lineage would read *4 of 18 · all loaded*, which is a worse sentence than the one being fixed. *Y* follows what was replayed, never what exists.
- **Clamping.** `Math.min(X, Y)`, or hiding the fraction when it exceeds one, would make the bizarre display go away and leave the surface answering "is anything missing?" from the wrong population. The complaint is not that the number looks strange.
- **Paging into an ancestor.** Not needed and not built: ancestors replay whole ([F05]), so there is nothing older to page into once the tip's own turns are loaded.
- **The resume-sheet seat defect.** `notes/arc-notes-restore-seat-brief.md`, running as `burly-spar`. It decides *whether* a lineage is sent on that path; this brief decides what the bar says once one is. They touch neighbouring lines in `do_request_replay` and are otherwise independent.

---

## Exit {#exit}

**A plan**, one phase. Its first act is the observation in Open Questions; then [B02]'s remembered list and [B01]'s sum with [B06]'s bridge tests in one round, and [B06]'s pure test in another. The phase boundary is the join. If the arc lands after `burly-spar`, rebase order is the only interaction; if before, nothing about it changes.
