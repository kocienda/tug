# An Arc's Question Gets Answers

**Purpose:** When an arc stops to ask the user something, the Session card shows the question and exactly one button, Resume. There is no way on the card to say no, to say something else, or to leave it, and nothing says how an answer is meant to be given.

---

## Purpose {#purpose}

Tito's report, in full:

> Tug asks me: "Approve steps 3 to 5?…", showing a RESUME button only.
>
> - If I agree, I click RESUME
> - If I don't agree, shouldn't the UI present a button next to it in case we want it to simply stop? It could be CANCEL, or perhaps STOP.
>
> In short, Tug displays a question without the possibility to respond cleanly.

He hit it often enough in one day to write. The request from the user: give the reader more options at this point, as Tito suggests, and make this point in the app easier to understand and deal with.

---

## Evidence {#evidence}

**[F01] The question is a stage's `arc ask`, and it is a stop.** A stage that meets a decision it may not make runs `tugtool arc ask <name> "<question>"`. `arc_ask` in `tugrust/crates/tugcast/src/arc_api.rs` performs `arc_stop`'s resolution and returns the stop under `ArcStopReason::NeedsDecision` with the question as payload; the question is written as the arc's last `arc-note`, and `format_arc_stop_receipt` in `tugrust/crates/tugcast/src/feeds/arc_runner.rs` reads it back as the line beneath the stop's sentence. The verb takes a name and a question and nothing else (`ArcCommands::Ask` in `tugrust/crates/tugtool/src/arc.rs`). **(verified)**

**[F02] The receipt shows the question as a tail line and offers one Resume, the same offer every resumable stop gets.** In `tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx` the question is `parsed.stop.said`, drawn as a plain `arc-receipt-tail` paragraph under the stage rows. Below it `ArcResumeOffer` is a `TugInlineDialog` titled "Resume this arc" (`ARC_RESUME_OFFER_TITLE`) with a single `Resume` button. `shouldOfferResume` reads the outcome, the terminal marker and `superseded`, and never the stop's reason, so an ask and a stall wear the same offer. The question and the button are two unrelated things that sit together, which is why the reader takes Resume for "yes". **(verified)**

**[F03] The one-button offer was a decision, made about stops in general.** The block's own comment ([B03] of the arc that built it): "One button, and no dismissal. A `Not now` would be mount-local state for a row that scrolls away on its own." `ParsedArcReceipt.stop.said`'s comment in `tugdeck/src/lib/arc-receipt.ts` goes further: the question "is why that stop needs no answer affordance of its own". **(verified)**

**[F04] The intended way to answer is to type in the composer and then press Resume, and nothing on the card says so.** `tuglaws/arc-lifecycle.md`'s stop table gives the resume for `needs a decision` as "answer it, then `tugtool arc run <name>` — the stage rotates again knowing what you said"; the doctrine (`tugplug/doctrine/arc-work-doctrine.md`) says "the user answers in their own conversation". **(verified)**

**[F05] A resume carries the stop's reason and never an answer.** `continue_stage` and `opening_prompt` build the resume clause from `record.last_stop`, a `(stage, reason)` pair, and the composed prompt reads "this arc was stopped in implement — needs a decision; it is resuming" (pinned by `a_rotated_resume_is_told_it_is_resuming`). So an answer reaches the stage only when it was typed into the stage's own session and that session is the one resumed. A bare Resume carries nothing, and a resume that rotates a fresh session starts with no record of what the user said. **(verified for the prompt text; that a rotated session therefore lacks the answer is read from the code, not reproduced)**

**[F06] A stop receipt is demoted by a later row for the same arc, or by an open turn.** `markSupersededArcStops` and `supersedeByOpenTurn` in `tugdeck/src/lib/session-transcript-data-source.ts` set `arcStopSuperseded`; the block then folds the receipt, drops its tone to `idle` and withdraws the offer. A pick-up note is such a row. **(verified that the mechanism exists; which arc-note commands count as answering was not enumerated)**

**[F07] An ask reads as an error.** `arcReceiptPhase` returns `error` for every stop that is not demoted, and the header note is `Stopped · needs a decision`. **(verified)**

**[F08] "Approve steps 3 to 5?" is not a string the plugin ships.** A search of `tugplug/`, `tugdeck/src`, `tugcode` and the Rust crates finds no "Approve" wording, so a stage composed that question itself. The doctrine's never-ask list forbids asking whether to keep going, so this question should not have been asked; which stage asked it on Tito's machine is not known. **(the search is verified; the stage is unknown)**

**[F09] Resume and Discard are already reachable away from the receipt.** `arcVerbs` in `tugdeck/src/lib/arc-verbs.ts` gives a stopped arc Resume in its first slot and Discard among the housekeeping verbs, on the Arcs card's row, the Session card's `ARC` popover and the Changes shade's arc lane. **(verified)**

---

## Decisions {#decisions}

**[B01] A `needs a decision` stop is a question with answers; every other stop keeps the receipt it has.** The reason on the receipt's own header is what selects the new shape, so a stall, an idle stop and a user's stop are untouched. This narrows [F03] rather than reversing it: "no answer affordance of its own" was written when the question was treated as a note under a stop, and Tito's report is that readers treat it as a question.

**[B02] The question is the dialog.** On an ask stop the inline dialog's title is the stage's question, with a caption naming who asks ("the implement stage asks"). The question no longer also appears as a tail line beneath the stage rows. "Resume this arc" stays the title for every other stop.

**[B03] A stage names its choices, and each choice is a button.** `tugtool arc ask` gains a repeatable `--choice "<label>"`. The choices ride the record and the receipt with the question, so a restored transcript draws the same buttons with no live store ([F01]'s receipt is a frozen record, and that stays true). A press on a choice is the answer and the resume in one gesture. What would revisit this: stages that cannot be got to pass choices, in which case [B04] already covers every question.

**[B04] `Reply…` is always offered.** It opens a one-line field inside the dialog; sending it is the answer and the resume in one gesture. It covers "no, but do this instead" and any question with no closed set.

**[B05] `Keep Stopped` is always offered, and it is recorded.** This is Tito's Cancel. The arc is already stopped, so the press changes nothing about the arc; it writes an arc note saying the user left it stopped, which is a later row that demotes the receipt ([F06]). Resume stays on the arc's row and popover ([F09]). Because it is a row on the record and not state held by the mounted block, it is not the `Not now` [F03] ruled out.

**[B06] The answer goes on the arc record and into the resume prompt.** A new answer act writes the user's reply (a choice's label or the typed text) as an arc note before the resume, and the resume clause gains it: "…needs a decision; the user answered: <text>; it is resuming". This closes [F05]: a rotated session knows what was decided, and the transcript shows it.

**[B07] Bare Resume is dropped when choices are present, and is a quiet third button when there are none.** Confirmed by the user. With choices, every exit is covered and a Resume that answers nothing invites the misreading in [F02]. Without them, someone who already answered in the composer ([F04]) still needs a way to go.

**[B08] Discard stays off the receipt.** Confirmed by the user. It is destructive and already on the arc's row and popover ([F09]).

**[B09] An ask receipt already in a ledger gets Reply, Resume and Keep Stopped.** Confirmed by the user. Such a row carries no choices, so it reads as [B07]'s second case. Nothing rewrites recorded rows.

**[B10] An ask is not an error.** The ask receipt wears an attention tone in place of `error`, and its header note reads `Asked · <stage>` in place of `Stopped · needs a decision` ([F07]). The other registers that speak a stop (the compact mark's tooltip, the Z2 cell) are left to the arc to bring into line with the same word.

**[B11] The stage skills are told about choices, and told again what may not be asked.** The four stage skills and the doctrine's `arc ask` passage say to pass `--choice` whenever the question has a closed set of answers, and restate that asking for approval to continue through declared steps is forbidden ([F08]). The surface is fixed so that a question that should not have been asked is still answerable; the wording is fixed so that it is asked less.

---

## Open Questions {#open-questions}

- **How the choices are carried in the record's note and the receipt's text.** The note vocabulary is closed and the receipt is parsed line by line, with the first unmarked line taken as the question. The carriage has to keep an old parser reading a new row sensibly and a new parser reading an old row as [B09] says. Settled by whoever writes the parser; it changes no decision here.
- **Whether a typed composer turn, with no button pressed, should also be recorded as the answer.** Today such a turn demotes the receipt ([F06]) and leaves the arc stopped. [B07] keeps bare Resume for exactly this reader, which is enough for the decisions above; recording the turn as the answer would be a further step and was not discussed.

---

## Non-goals {#non-goals}

- **A dialog raised by the stage.** `AskUserQuestion` inside a stage stays forbidden; the doctrine's reasons (a pause the record cannot see) are unchanged. The ask remains a stop.
- **Discard, or any other destructive verb, on the receipt.** [B08].
- **A dismissal that is only local state.** [F03]'s objection stands; [B05] is a recorded act.
- **New exits on the other stops.** A stall, an idle stop, a lint stop and a user's stop keep one Resume.
- **Finding and fixing the one stage that asked "Approve steps 3 to 5?".** It is not known which it was ([F08]); [B11] addresses the class.

---

## Exit {#exit}

**An arc.** The work has three layers, and the server's has to land before the card's can be exercised end to end:

- The verb and the record: `arc ask` accepts choices and writes them with the question; the stop receipt's text carries them; a new answer act writes the reply as a note and then resumes; a recorded "left stopped" note; the resume clause carries the answer on both the continue and the rotate path.
- The card: the receipt parser reads the choices; an ask stop draws the question as the dialog with its choice buttons, `Reply…` and its field, `Keep Stopped`, and bare Resume only when there are no choices; the attention tone and the `Asked` note; the "left stopped" note demotes the receipt.
- The words: the four stage skills, the doctrine's `arc ask` passage, and the `needs a decision` row of `tuglaws/arc-lifecycle.md`'s stop table, which names the user's resume and will now name an answer.
