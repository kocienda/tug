# Arc interstitials: one register, the server's clock, said before the ask

**Purpose:** An arc stopped during implementation; when the user resumed it, the Wheel's `Picked back up` receipt sat beneath the streaming turn at the bottom of the transcript for the whole turn. The user asked for a complete audit of how the arc-related rows the Wheel and Tug put into the transcript are handled, and for a better design. This brief records the audit and settles the design.

---

## Purpose {#purpose}

The user's report:

> An arc stopped during implementation. When I resumed it, this message stayed stuck on at the bottom of the transcript. It shouldn't. I want a complete audit for how these arc-related pinned Stop/Resume prompts and other messages (by the Wheel or not) are handled in the transcript.

The screenshot showed a Wheel entry — `Wheel 6:07:46 AM • /Users/kocienda/Mounts/u/src/tug #s4`, the arc's lifecycle strip reading `Picked back up`, and a body of one clause, `a resume asked for it` — sitting below the resumed stage's in-flight tool call, with Z2 reading `Streaming`.

---

## Evidence {#evidence}

**[F01] The row is not pinned; it is an ordinary shell-ledger row seated by timestamp, and the live path gives it the wrong one.** `use-landing-receipts.ts` ingests the `arc_receipt` frame through `ingestShellExchange` with `startedAtMs: Date.now()` — the deck's arrival time. The `arc_receipt` and `arc_note` frames carry no timestamp (`changeset-verb-store.ts`, `arc_receipt` arm), though the ledger row behind them holds `started_at_ms` (`control/changeset.rs:1995-2009`). **(verified)**

**[F02] The server writes the pick-up after the prompt that picks the arc up.** `continue_stage` (`tugrust/crates/tugcast/src/feeds/arc_runner.rs:3282`) sends the model, publishes the Wheel's `tug_notice`, dispatches the resumed `user_message`, records the wheel prompt, and only then calls `record_resume_receipt` (`:3429`). `rotate` (`:2855`) writes the receipt only after `wheel::rotate` returns `Ok` (`:3099-3102`). So the receipt's clock is always later than the resumed turn's submit. **(verified by reading the code)**

**[F03] Ink newer than the pending submission seats at the foot, and stays there until the turn commits.** `composeRowLayout` in `session-transcript-data-source.ts` moves a trailing shell row below the in-flight turn when its timestamp is greater than the submission's ("anything left is newer than every pending submission — it sits at the foot"), mirroring `appendTurnInterleavingInk` in the reducer. An implement turn can run many minutes, and the row rides under it the whole time; at commit it lands between the resumed turn and the next. This is the right rule for a shell command the user ran mid-turn, and the wrong seat for a fact that preceded the turn. **(verified)**

**[F04] Restore seats the same row somewhere else.** The ledger row carries `anchor_msg_id = latest_assistant_msg_id` at write time (`session_ledger.rs:1607`), which on the continue road is the last assistant message before the resumed prompt; `hoistInkAnchoredTo` seats an anchored row after its anchor turn. A reload therefore shows the pick-up **above** the resumed turn, where the live path showed it below. Live and restore disagree about the order of one event, against the parity the receipts otherwise keep byte for byte. **(the anchor's value is read from the code; the on-screen restore order was not reproduced)**

**[F05] The pick-up receipt carries nothing a receipt is for.** `SessionArcReceiptBlock` keeps the entry shape for stops and pick-ups because, per `briefs/join-report-brief.md` [B04], "they carry the stage's own words and the Resume offer, which a quiet line cannot". A pick-up's body is `parsed.resumed.moved` alone — one of `a resume asked for it`, `a step closed`, `a wake on its session`, `a turn opened on its session` — with no offer and no stage words. It exists to supersede the stop row (`markSupersededArcStops` adds every parsed arc receipt's arc to the answered set). It is the same shape as the finish, which that brief already made a quiet line. **(verified)**

**[F06] The census of what reaches the transcript.** Durable, restored rows: the Wheel's prompt openers (a user row attributed to the Wheel, live via a `tug_notice` of origin `wheel` that opens the turn, restored through the `wheel_prompts` table); the stage divider (`source: "stage"` system note, hoisted below the footer when it closes a turn); the arc notes (`feeds/arc_notes.rs` derives `arc step <name> done`, `arc create`, `arc mark`, `arc commit` lines from the arc log; mid-turn they are `source: "arc"` system notes inside the open turn, between turns their own quiet ink row, and `absorbArcNotes` re-seats them by clock on restore); the `/arc-run` row in four shapes — complete (a quiet finish line), stopped (a Wheel entry with the stage's words and the Resume offer, demoted when a later row answers it), picked back up (a Wheel entry, [F05]), and the join or discard ending; and the landing receipts `/arc-join` with its `Joined` boundary, `/arc-discard`, `/arc-delete-documents`. Live-only, never ledgered: the base-motion and crossing notices, the `arc-resolve` pane bulletin, the press-refusal bulletins, and the join narration in the transcript's un-indexed live-edge slot. **(verified)**

**[F07] The join or discard ending renders as a raw shell block under a Wheel header.** `stop_arc_for_session` formats it inline as `arc joined · <arc> · the stage's turn will end and the card returns to <model>` (`arc_runner.rs:3682`). None of `COMPLETE_RE`, `STOPPED_RE`, `RESUMED_RE` in `arc-receipt.ts` matches that header, so `parseArcReceipt` returns `null`, `arcReceiptPresentation` answers `entry`, and `SessionArcReceiptBlock` falls through to the generic `ShellExchangeBlock`. **(read from the code; not confirmed on screen)**

**[F08] The runner's own notes never reach a card.** `note_for_line` excludes every `arc-*` marker on purpose, so the runner's `picked back up: …`, `compacted at …`, `prompted past N open background job(s)`, and `model → <selector> in <stage>` notes live only in `arc-log.md` and `tugtool arc record`. The bind and the Resume press write nothing to the transcript at all (`arc_api.rs:331`). **(verified)**

**[F09] Supersession sees only shell rows.** `markSupersededArcStops` walks `cellKind === "shell"` slots and parses `/arc-run` and `/arc-join` outputs. A fact seated inside a turn as a system note is invisible to it. **(verified)**

**[F10] What is pinned today.** `at0476-arc-stop-resume` presses the Resume button on a real stop receipt and asserts one offer row, one `arc-resume` log line and no later `arc-stop`; it asserts nothing about where the pick-up seats. `at0529-arc-finish-quiet-line` pins the finish's quiet seat; `at0507-arc-note-quiet-row` and `at0508-arc-note-task-register` pin the arc note's two seats; `session-arc-receipt-block.test.ts` pins the parser and `shouldOfferResume`; the data-source tests pin `arcStopSuperseded`. **(verified)**

---

## Decisions {#decisions}

**[B01] A stop is the only Wheel row that keeps entry chrome; every other Wheel utterance about a running arc is a quiet line in the arc-note register.** The stop alone carries an offer and the stage's own words, which is the whole reason the join-report brief's [B04] kept an entry. The pick-up becomes `arc resume <name>` with the sentence `<name>: picked back up · <what moved>` and the rotate glyph; the join and discard endings become `arc joined <name>` and `arc discarded <name>` with their existing sentence and the wheel glyph. No participant header, no cwd, no `#s` address, no copy or collapse: nothing ran on the card. `arcNoteParts` gains the three commands, and `arcReceiptPresentation` no longer has a `resumed` arm to answer `entry` for. This supersedes the second half of join-report [B04].

**[B02] The pick-up rides the arc-note channel, not the receipt channel.** The runner announces it through `record_arc_note` with the synthetic command above, the way `arc ask` writes its question. That gives it the arc note's two seats for free: a `source: "arc"` system note inside the open turn when the resume continues a live session, its own quiet row when it rotates or lands between turns. The in-turn seat is what ends the foot-pinned row ([F03]): a note inside the turn scrolls with the turn's content. `note_for_line` keeps excluding the `arc-resume` log marker, so the line is painted once and never twice. The `arc_receipt` frame is left to the two shapes that still need it, complete and stopped.

**[B03] The pick-up is said before the ask.** In `continue_stage` and `rotate` the note is written before the prompt is dispatched, so the transcript reads in the order things happened: picked back up, the Wheel's ask, the stage's work. On the rotate road a refused rotation still writes its stop receipt afterward; the pick-up line above it was true when written, and the later stop supersedes nothing because a pick-up is not a stop. The `/arc-run` complete receipt already writes before its hand-back; this makes the pick-up consistent with it.

**[B04] Every arc frame carries the ledger row's clock, and the deck uses it.** `arc_receipt` and `arc_note` gain `started_at_ms`, and `use-landing-receipts.ts` ingests that for `startedAtMs`, `settledAtMs` and the note's `timestamp` instead of `Date.now()`. Live and restore then compute every seat — the data source's interleave, `absorbArcNotes`, `appendTurnInterleavingInk` — from one clock, and the ledger row stays the single source ([F01], [F04]). A frame without the field falls back to arrival time, which is today's behaviour, so an older tugcast changes nothing.

**[B05] Supersession reads the pick-up wherever it sits.** `markSupersededArcStops` also walks the turns' `source: "arc"` system notes and the quiet rows whose command is `arc resume <name>`, adding the arc to the answered set, so the stop's Resume offer folds the moment the pick-up lands in either seat ([F09]). A join or discard ending folds the stop the same way, by its new command.

**[B06] The parser keeps its legacy rows.** Every `arc picked back up · …` and `arc joined · …` row already in a ledger still parses and still renders — the pick-up as the quiet line [B01] describes, read from the old header — so a transcript recorded before this lands reads the same as one recorded after. `RESUMED_RE` and a new ending regex stay in `arc-receipt.ts` for that reason, and the supersession pass keeps its `/arc-run` arm.

**[B07] The pins.** `at0476-arc-stop-resume` asserts the resumed card shows the pick-up as a quiet line above the resumed turn's first row, never below it, and that the Resume offer on the stop folds; its restore sibling asserts the same order after a reload. A data-source unit test pins that an arc note stamped before the pending submission never seats at the foot. The supersession table test gains the arc-note arm. `arc-receipt.test.ts` gains the ending header and keeps the legacy pick-up case. The Rust side pins the write order of [B03] in the runner's frame-sequence harness, and the `started_at_ms` field on both frames.

---

## Open Questions {#open-questions}

- **Whether wheel-attributed stop receipts keep the cwd and `#s` address.** A stop ran in no directory and nobody typed it. The recommendation is to drop both for every `attribution: "wheel"` entry, leaving the Wheel name and the time; it changes `ShellTurnCell`'s receipt-row branch and `at0476`'s header assertions, and is the user's call because it is a visible chrome change on a row they read often.
- **Whether the runner's own notes become quiet lines too.** `compacted at …`, `prompted past N open background job(s)`, and `model → <selector> in <stage>` ([F08]) are exactly the interstitial facts the report asked about, and the arc-note register is sized for them. The recommendation is to announce them through `record_arc_note` in the same change, since [B02] builds the channel and the seat; the question is whether the user wants a compaction and a model switch narrated on the card or kept to the record.

---

## Non-goals {#non-goals}

- **Pinning anything.** No arc row becomes live-edge content. The live-edge slot is for narration that is never ledgered (the join register); a pick-up is a durable fact and belongs in the row order.
- **Dropping the pick-up row altogether and folding the stop by store state.** A receipt may not read the present into a row that reports the past (join-report [F05]); the transcript's own later row is what answers an earlier one, and a card opened later must see the same answer from the ledger alone.
- **Changing the interleave rule for shell rows.** A command the user ran while a turn streamed did happen after the turn's submit and belongs below it. The fix is giving the arc rows an honest clock and an honest order, not bending the rule.
- **A "Not now" or any dismissal on the Resume offer.** Settled by the receipt's own brief and by `arc-never-stops-brief.md`.
- **Touching the `/arc-join`, `/arc-discard` and `/arc-delete-documents` receipts.** They are git- or Tug-voiced landings and already read correctly.
- **Rewriting a stop row when it is answered.** It stays frozen and demoted, as today.

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land: the server adds `started_at_ms` to both frames and the deck reads it ([B04]), which is safe alone and fixes the restore disagreement; the runner moves the pick-up onto the arc-note channel and writes it before the ask ([B02], [B03]), with the parser and the quiet-line grammar growing the three commands and the two shapes becoming quiet lines ([B01], [B06]); the supersession pass learns the new seat ([B05]); the pins last ([B07]). The two open questions can be answered at the door without changing the shape of the work.
