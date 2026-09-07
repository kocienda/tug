# One landing report: the commit in Git Commit, the arc behind Joined

**Purpose:** An arc's landing leaves three rows in the transcript — the Wheel's finish receipt, a `Git Commit` entry with nothing in it, and a `Joined` boundary carrying the commit's sha and receipt — and they read as two summaries of one event plus an empty row. This brief settles that the commit's content goes back to the entry named for it, the arc's record folds behind the boundary, and the finish moment becomes a quiet line. The design as approved is the candidate zone of `tugdeck/src/spikes/spike-join-report.tsx`.

---

## Purpose {#purpose}

The user, on the shipping rows:

> We are badly mangling this whole join reporting experience in the transcript. These elements need to be brought together in a more harmonious fashion.

Their notes, verbatim in substance: the subsidiary text is too small, because the small timestamp and path beside `Git Commit` was used as the model for substantive lines in the other two rows; the `Git Commit` message has been shorn of its typical content, which was handed to the `Joined` row below it — "I never asked for that"; there are essentially two join summaries and they want one, and if anything the `Joined` row's fold should hold what the Wheel row holds now; and the commit atom in the `Joined` row is off its baseline.

On the spike's candidate: make the Git Commit consistent with non-arc usages, make the Joined row keep its design similarity with the Compact row, and size every subsidiary line to the `Joined … into main` event's size, unbolded. A variant that put the commit pill back on the boundary's bar was drawn and rejected as "just confusing matters."

---

## Evidence {#evidence}

**[F01] The `Git Commit` entry is empty because its body is the boundary, which leaves the entry.** `SessionJoinReceiptBlock` (`tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx`) renders a `SessionBoundary` with `inTurn`, and `session-boundary.css` pulls an in-turn boundary to the transcript's edge with a negative inline-start margin equal to `--tugx-transcript-body-inset`. The entry's attribution row (`Git Commit`, time, cwd, `#s3`) is painted by `ShellTurnCell` in `session-card-transcript.tsx` with `attribution: "git"`, and the boundary lands below it as a rule and a bar. Nothing sits in the body column. **(verified)**

**[F02] The commit's content is on the boundary, not in the entry.** The join boundary's bar carries the sha pill and the squash subject as its detail run, its badges are files, ±, and rounds, and the fold body is the commit receipt's pieces: the `arc → base` identity line with the fit, the message, and `CommitChangesList`. A `/commit` on the main lane renders `SessionCommitReceiptBlock` inside the `Git Commit` entry instead: sha pill and subject on the header, file and ± badges, message and file list beneath, expanded by default. The same act wears two shapes depending on the lane. **(verified)**

**[F03] The arc's record is a separate entry.** `SessionArcReceiptBlock` (`session-arc-receipt-block.tsx`) renders the `/arc-run` row as a `Wheel`-attributed entry: `ArcLifecycleBlock` in row layout with the note `Finished · N stages`, then `opened on <document>`, one row per stage (`stage · model · cost`), and `plan <path>` when present. It is written by `useLandingReceipts` from the server's `format_arc_receipt` (`tugrust/crates/tugcast/src/feeds/arc_runner.rs`), which emits `arc complete · <arc>`, `opened on …`, `<stage> · <model> · <session id>` per stage, and `plan …`. **(verified)**

**[F04] The join summary carries no arc record.** `format_join_summary` (`tugrust/crates/tugcast/src/feeds/changeset.rs`) writes `joined <sha> · <arc> → <base> · <N> round(s)`, an optional `fit:` line, an optional `files:` line, then the message. Every line after the header is claimed by prefix; the message begins where the prefixes stop. The stages, the document, and the models are not in it. **(verified)**

**[F05] The subsidiary lines are set at the timestamp's size.** `session-boundary.css` sets the bar's detail slot to `--tug-font-size-xs`, and `session-arc-receipt-block.css` sets `.arc-receipt-doc`, `.arc-receipt-stage-word`, `.arc-receipt-stage-model`, and `.arc-receipt-stage-session` to `xs` too. The transcript entry's timestamp is `--tugx-transcript-timestamp-font-size`, also `xs`. The boundary's event reads at `--tugx-toolheader-name-size` (`sm`, semibold). **(verified)**

**[F06] The pill's baseline fault was two mismatches, and the rollout removes the pill from the bar anyway.** The pill wears the chip tier at 13px while the run around it was 12px, and the subject `<code>` inherited the header's 1px optical nudge for a bare mono command while the pill did not. Measured in the spike: at the run's size with the nudge cancelled the pill sat on the line. Rejected as a variant; recorded so the fix is known if a pill ever returns to a boundary run. **(verified in the spike)**

**[F07] The prose in the spike is a stand-in, not a finding about transcript prose.** The spike's column pins the transcript root's 14px and shrinks its prose lines to the event's size to match how the transcript already reads: `session-card.css` sets the markdown body at `0.95em` of the root. The rollout changes nothing about assistant prose. **(verified)**

**[F08] A complete arc and a stopped arc are the same command with three outcomes.** `parseArcReceipt` reads `arc complete`, `arc stopped`, and `arc picked back up` off one `/arc-run` row, and only the stopped outcome carries the Resume offer and the stage's own words. The command-block registry's `presentation: "quiet"` is per command, not per row. **(verified)**

**[F09] The arc-notes feed already omits the finish and the join on purpose.** `note_for_line` (`tugrust/crates/tugcast/src/feeds/arc_notes.rs`) says an `arc-*` marker "is the arc's own record and ends in the arc receipt" and a join "already paints its own landing receipt", so neither becomes a quiet line today. The quiet-line grammar (`arcNoteParts` in `tugdeck/src/lib/arc-note-command.ts`) is keyed on a closed set of synthetic commands. **(verified)**

**[F10] What is pinned today.** `at0419-join-receipt` pins the join as a commit-shaped receipt with the `arc → base` line; `at0521-arc-receipt-stage-usage` pins the stage rows' cost cell and the absence of any `session:` string; `at0507-arc-note-quiet-row` pins the quiet row seat; `session-boundary-anatomy` and `session-boundary-projection` pin the boundary's anatomy and its find-parts; `session-join-receipt-block.test.ts` and `session-arc-receipt-block.test.ts` pin the two parsers. **(verified)**

---

## Decisions {#decisions}

**[B01] A join's `Git Commit` entry carries the commit receipt, exactly as a `/commit` does.** `SessionJoinReceiptBlock` renders `SessionCommitReceiptBlock`'s receipt — sha pill and subject on the header, file and ± badges, message and `CommitChangesList` beneath, expanded by default, the same collapse key regime — inside the entry's body column. The join's own facts that a plain commit has no room for (`arc → base`, the fit) stay in that receipt as the identity line they are today. A join is a commit on the base and the user asked for it to read as one; the empty entry of [F01] was the cost of making it read as something else.

**[B02] The `Joined` boundary keeps the compaction's anatomy and folds the arc's record.** Rule, sunken bar, `GitMerge`, the bold event `Joined <arc> into <base>`, trailing badges `N stages · N rounds`, a chevron, and behind it the record the Wheel entry carries today: the `ArcLifecycleBlock` row with `Finished · N stages`, `opened on <document>`, one row per stage with model and cost, and `plan <path>` when present. No sha and no subject on the bar — the receipt above names the commit, and naming it twice is the doubling this brief ends. The boundary sits after the entry, at the transcript's edge, in the hoisted seat rather than pulled from inside a turn.

**[B03] The join summary carries the arc's record, by prefix.** `format_join_summary` gains the lines the boundary folds — the document, the stages, the plan — each claimed by its own prefix between `fit:` and `files:`, so the parser's cursor rule ([F04]) still holds and every receipt already in a ledger still parses. One string is still the single source and the live and restored rows still render byte-identically; a client that went looking for an earlier `/arc-run` row would have to find it across windows and cards and would fail on a card that opened after the arc ended. The server has the record at join time — the runner's own reading is what `format_arc_receipt` formats, and the arc's log is what the join reads its rounds from.

**[B04] A complete arc finishes as a quiet line; a stopped or picked-up arc keeps its receipt.** The complete outcome's `/arc-run` row no longer paints a Wheel entry with the record in it; it paints an arc-note quiet line — `<arc> Finished · N stages` with `ShipWheel` — at the body inset, the seat every other arc gesture has ([F09]). The record is not lost: it folds behind the boundary once the arc lands ([B02]), and until then it is the Arcs card's. Stopped and picked-up arcs keep `SessionArcReceiptBlock` because they carry the Resume offer and the stage's own words ([F08]), which a quiet line cannot. Because presentation is per command, the row's renderer decides by outcome: the quiet shape for complete, the receipt for the other two.

**[B05] Subsidiary text reads at the boundary event's size, unbolded.** The arc record's rows and its lifecycle line, wherever they render, take `--tugx-toolheader-name-size` at `--tug-font-weight-normal` with the header's line box, and the boundary's detail slot moves from `xs` to the same size. The event's semibold is the only weight in the bar. The timestamp and cwd beside an entry's identifier stay at the stamp size — that is provenance, and it was the wrong model for the rest, not wrong in itself.

**[B06] The commit pill stays off the boundary.** The bar names the event and counts; the receipt names the commit. The fix in [F06] is recorded, not applied.

**[B07] The pins.** `at0419` asserts the join's `Git Commit` entry contains a commit receipt with the sha pill, the subject, the `arc → base` line, and the file rows, and that the `Joined` boundary follows it at the transcript's edge with the arc record behind its fold. `at0521` moves its cost-cell assertions to the folded record. A new app-test asserts a complete `/arc-run` row is a quiet line at the body inset and a stopped one is still a receipt with its Resume offer. The two parser unit tests gain the prefixed record lines and keep their legacy-row cases. `joinReceiptFindParts` projects the record's lines only when the fold is open, on the declare-both-halves rule the projection test already enforces.

---

## Open Questions {#open-questions}

- **Which prefixes.** `opened on ` and `plan ` are already words the arc receipt uses; the stage lines have no prefix today because `STAGE_RE` keys on the closed stage vocabulary. Whether the join summary reuses those spellings verbatim or wears one `arc:` prefix per line is the devise round's, with the constraint that a join message beginning `plan …` must not be eaten.
- **The quiet line's label weight.** The spike unbolds the `Finished` label to match the rest of its column; the production arc-note line's label is semibold. The recommendation is to leave the arc-note register alone and let `Finished` read as every other gesture does, since [B05] is about the boundary and its fold rather than the quiet line.

---

## Non-goals {#non-goals}

- **A second boundary shape.** The join keeps `SessionBoundary` unchanged in anatomy; only its contents and seat move.
- **The pill on the bar.** Drawn, judged confusing, dropped ([B06]).
- **Changing assistant prose size.** [F07].
- **Touching the `/arc-discard` receipt.** A discard lands nothing and is not a boundary; its receipt stands.
- **A wire or reducer change for the record.** It rides the summary string ([B03]); no new message kind.

---

## Exit {#exit}

**A plan**, one phase. Round one is the server: `format_join_summary` carries the record and the Rust table tests pin the bytes. Round two is the join block: the receipt back in the entry ([B01]), the boundary after it with the record folded ([B02]), `session-boundary.css` and the record's rows at the event's size ([B05]), the find-parts, and `at0419`. Round three is the arc receipt: the complete outcome as a quiet line, the other two untouched ([B04]), and its app-test. The spike is deleted in the last round with its two registry lines, and the taxonomy pin goes from fourteen back to thirteen.
