# One boundary for the three times the ground moves

**Purpose:** The transcript has three rows that mark a change in what is *underneath* the conversation rather than something a participant said: the session compacted, an arc rotated the card onto a fresh claude session, and an arc joined its base. Two of them share a bar; the third borrows a command's outcome idiom and sits at a different indent. This brief settles that the three are one kind, gives that kind one anatomy, and says where the anatomy is seated. The spike is `tugdeck/src/spikes/spike-session-boundaries.tsx`, zone **One boundary — the same anatomy, three times**, which is the design as approved.

---

## Purpose {#purpose}

The user, looking at the settled `Joined arc-resolve into main · joined` row under a join receipt:

> \[it\] feels more like one of these dividers. Think about these as a single kind of thing.

And on the spike's second zone:

> I really like: ONE BOUNDARY - THE SAME ANATOMY, THREE TIMES. Only the leftmost text label should not set a tab margin for subsequent lines.

The kind is real. A compaction swaps the model's context; a stage rotation swaps the claude session and usually the model; a join swaps the base the card sits on. Above each row the transcript ran in one world and below it in another. That is what a boundary is, and it is not what an arc-note ("Step 2/5 closed") or a Tug notice is — those are events that happened *on* the ground, not the ground moving. The code already half-knows this: the stage divider's docstring says it takes the compaction bar's shape "deliberately so" because "both are session-meta events". This brief finishes the thought and brings the join in.

---

## Evidence {#evidence}

The compaction bar is `SessionCompactionEntry` in `tugdeck/src/components/tugways/cards/session-compaction-entry.tsx`; the stage bar is `StageDivider` in `session-card-transcript.tsx`; the join's settled row is `ArcJoinRegister` mounted by `SessionJoinReceiptBlock` in `session-join-receipt-block.tsx`; the wrappers' CSS is in `session-card.css` (`.session-card-transcript-compaction`, `.session-card-transcript-stage`) and `session-join-receipt-block.css` (`.join-receipt-register`).

**[F01] Compaction and stage already share one bar and one rhythm.** Both wrap a `BlockChrome` re-toned to the sunken surface (`.session-compaction-bar`, `.session-stage-bar`) in a wrapper that draws a hairline rule across the row with a 2xl margin above and lg padding below. Compaction leads with `Layers`, names the event `Session compacted`, carries `~Nk tokens` as a text summary, and folds the recap markdown behind a chevron. Stage leads with `Milestone`, names the event `Stage`, carries `<stage> · <model> · <document>` (from `stageNoteText` in `lib/code-session-store/stages.ts`) in the detail slot, and folds nothing. **(verified)**

**[F02] The join's settled row is the outcome idiom, not the boundary idiom.** `ArcJoinRegisterView` renders a bare `BlockHeader` with the phase's pulsing dot (green at rest), the register's sentence as `target`, and the register's word (`joined`) as a text summary. It is hung under the receipt with an xs gap and no rule. The word repeats the sentence's first word. **(verified)**

**[F03] The join sits at a different indent from the other two.** The receipt and its register render inside the `$`-route `ShellTurnCell`, so they land at the body column's inset (`--tugx-transcript-body-inset`). The compaction-only turn and the closing stage note are hoisted out of the assistant attribution and render at the transcript's edge, full width. **(verified)**

**[F04] Both existing boundaries also have an inset seat.** A compaction that arrives alongside other assistant content, and a stage rotation that catches a turn open, render in place inside the assistant body column and inherit its inset. So even the two bars that agree are seated at two x positions depending on when the event landed. **(verified)**

**[F05] The bar's header puts the detail in a column beside the name, and a wrapped detail hangs under that column.** `BlockHeader` lays out `toolName` and `target` as flex siblings in `BlockStrip`; the detail slot is `inline-flex` with a `min-height` of one line. A long join subject wraps with its second line starting where the detail began, not at the row's text edge. The user rejected this for the boundary. The spike's answer is to render the event and its detail as one inline run in the detail slot, with the slot switched to `display: block` and normal wrapping, so a wrapped line returns flush to the glyph's gutter. **(verified in the spike)**

**[F06] The strip's name slot carries the block's accessible name.** `BlockHeader` derives `ariaSubject` from `toolName` for the copy and fold buttons' labels, falling back to a neutral label when it is empty. The spike leaves `toolName` empty to get the flow in [F05], which is acceptable in a spike and not in the component. **(verified)**

**[F07] The live join register is a different surface with a different job.** During a join the register narrates beats (`Joining arc-resolve into main — squashing`) at the transcript's live edge, on the Arcs card row, and on the composer's status row, and [D142] makes its phase dot mean what it means over every tool call. That register is status, and status stays a register. Only the row that *settles* into the transcript after the receipt is a boundary. **(verified)**

**[F08] The join receipt is a commit receipt by design.** `session-join-receipt-block.css` says it is "deliberately the commit receipt's skeleton: a landing is a commit on the base, and a reader should not have to learn a second shape for it." Its identity line carries the sha with the commit's own context menu ([D142]'s "one vocabulary"). **(verified)**

**[F09] Arc-notes and notices are not this kind and already have a home.** Arc gestures are `ArcNoteLine` on the `TugQuietLine` substrate ([P12]) with an inset seat; Tug notices are `SessionNoticeLine` with an accent rule down their side. The stage-rotation *model switch* mid-stage is recorded as an arc-note (`model → <selector> in <stage>`), not as a boundary. **(verified)**

**[F10] Nothing pins the three against each other.** No test asserts that a compaction bar, a stage bar and a settled join row share a class, a rule, or an x position. **(verified)**

---

## Decisions {#decisions}

**[B01] The three are one component, and its name is boundary.** A `SessionBoundary` in `components/tugways/cards/` renders every "the ground moved" row: compaction, stage, join. It replaces `SessionCompactionEntry`'s chrome, `StageDivider`, and the settled `ArcJoinRegister` under the receipt. Anything that changes the context, the session, or the base of the card goes through it; anything that merely happened on the card does not ([F09]).

**[B02] One anatomy.** A hairline rule across the row; below it a sunken bar (`--tug-surface-sunken` over `--tugx-block-border`, `--tug-radius-md`); inside the bar a leading glyph, the bold event, the muted detail, a trailing summary of badges, and a chevron only when something folds behind the bar. The rhythm is the compaction wrapper's today: 2xl above the rule, lg between rule and bar, xs below. The three instances:

| Boundary | Glyph | Event | Detail | Trailing | Fold |
|---|---|---|---|---|---|
| Compaction | `Layers` | `Session compacted` | none | `~142k tokens` | the recap markdown |
| Stage | `Milestone` | `Stage 3 of 5 · review` | `sonnet → opus · <plan path>` | the model | none |
| Join | `GitMerge` | `Joined arc-resolve into main` | sha and squash subject | files, ±, rounds | the receipt body |

The phase dot is not part of the anatomy. The receipt already says the command succeeded; a boundary is not an exit status.

**[B03] The event and its detail are one inline run, and the run wraps flush.** Per [F05], the bar does not put the event in the strip's name slot and the detail in the column beside it. The event is a bold span at the head of the detail slot, the detail follows it in the same run, and the slot flows as a block with normal wrapping so a second line lands under the event's first character. The accessible name ([F06]) is supplied another way — an `aria-label` on the header or a visually hidden name — so the copy and fold buttons keep saying what they act on.

**[B04] Always the transcript's full width.** A boundary belongs to the transcript, not to a speaker's column, so every seat lands at the edge. The hoisted seats already do ([F03]). The in-turn seats ([F04]) stay in document order and pull to the edge with a negative inline-start margin equal to `--tugx-transcript-body-inset`, which is a CSS-only change under [L06]. The join moves from the `$` cell's inset to the edge because it is rendered by the boundary, not by the shell cell.

**[B05] The join's receipt folds behind the boundary.** Variant A in the spike. The boundary bar is the row a reader meets; the commit receipt (identity line with the sha and its menu, the message, the file list) is the fold body, the way the recap is the compaction's fold body. The fold is built from the receipt's body pieces, not by nesting `SessionJoinReceiptBlock` inside the boundary's chrome — the spike strips the inner frame by CSS to preview the look, and the component should not carry that hack. The receipt's copy text, commit menu, and `ToolBlockHistoryCollapse` key are kept so [F08]'s "one vocabulary" survives the move. The `/dash-discard` receipt is not a join and keeps its receipt shape.

**[B06] The live register is untouched.** Per [F07], `ArcJoinRegister` keeps narrating on the Arcs card row, the shade, the composer, and the transcript's live edge. What changes is only that the settled row `SessionJoinReceiptBlock` appended is now the boundary. `arcJoinRegister` the derivation is unchanged; its terminal `joined` sentence is what the boundary's event reads.

**[B07] Stage says which stage and which model.** Today's bar says `Stage` and leaves the rest to the detail. The boundary's event is `Stage <n> of <total> · <stage>` when the count is known and `Stage · <stage>` when it is not, the detail is `<from> → <to>` when the model changed and the plan path, and the trailing badge is the model the card is now on. `session_stage` already carries `stage`, `model`, `document`, and `steps`; the step count and the previous model come from the same event or from the store's last stage note, whichever is cheaper, and the plan settles it.

**[B08] The pins.** A component test that the three boundaries render one root slot and one anatomy: rule, bar, glyph, event run, trailing summary, and a chevron only on the two that fold. A test that a long join subject's second line begins at the same x as the event ([B03]). An app-test on the compaction and stage seats asserting the bar's left edge equals the transcript's edge in both the hoisted and the in-turn seat ([B04]), and that the settled join row is a boundary at that same edge with the receipt folded behind it ([B05]). The existing compaction-run watcher, which reads `source: "compact"` off the store, is not touched and its tests stand.

---

## Open Questions {#open-questions}

- **Where does the accessible name go?** [B03] needs the strip to have a name while its name slot is empty. `aria-label` on the header is the simplest; a visually hidden span inside the run is the alternative. The plan's first component round decides.
- **Does the in-turn compaction seat survive the pull?** [B04]'s negative margin assumes the assistant body column has no `overflow: hidden` ancestor between it and the transcript edge. If one exists the seat needs a different mechanism; the spike proves the look, not the DOM.

---

## Non-goals {#non-goals}

- **Folding arc-notes or notices into the boundary.** They are events on the ground, not the ground moving ([F09]). Their quiet-line seat and the notice's accent rule are exactly right and stay.
- **Changing the live register.** [B06]. The join's beats are status and status wears the tool-call header's phase vocabulary by [D142].
- **A new store message kind.** Compaction and stage already arrive as `system_note` with `source: "compact"` and `source: "stage"`; the join arrives as the receipt's shell exchange. The boundary is a rendering decision over messages that already exist. No wire change, no reducer change.
- **Re-styling the commit receipt.** `/commit`'s receipt is a receipt and stays one. Only the join's *settled row* changes, and its receipt is preserved inside the fold.

---

## Exit {#exit}

**A plan**, one phase. Round one is the component: `SessionBoundary` with [B02]'s anatomy, [B03]'s inline run and accessible name, [B04]'s edge seating, and the compaction and stage call sites moved onto it with the component test from [B08]. Round two is the join: the settled register replaced by the boundary with the receipt folded behind it ([B05]), the `$` cell's inset dropped for that row, and the app-test from [B08]. Round three is [B07]'s stage words. The spike is deleted in the last round, with its two registry lines and the taxonomy pin moved from fourteen back to thirteen.
