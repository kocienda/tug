# An Arc Fixes First, and Asks in the App's Question Dialog

**Purpose:** An arc at its audit stopped and asked the user what to do about a red test that it could have fixed, on a diagnosis that was wrong, with two of its three options leading nowhere. The user was left with a red `Stopped` receipt and one `Resume` button. An arc that cannot reach a joinable state has to work the problem itself, and when a decision really is the user's, it has to arrive as a proper question with the work behind it.

---

## Purpose {#purpose}

The user's report, over a screenshot of the stop:

> This actually needs to be presented as an answerable question with the AskUserQuestion facility in the app, eh? … We can't leave them stranded in a ditch at the side of the road like this. We need to be *much* more helpful in resolving this sort of issue and getting the user back on track. We need to provide active assistance to resolving such issues and giving them an arc they can join.

The stop's text, as the receipt showed it:

> The re-audit cannot mark: at0523-arc-transport-stop is red on the new base even with this arc's deck changes reversed (typed keys hit noResponder, the open defect behind at0476/at0633), and arc verify cannot leave it out — fix the keyDown routing in this arc, delete at0523 as a known base red, or wait for a fix on main and re-audit?

And the user's ruling on where the fix goes: "The whole goal is to help the user resolve the issue. no separate fix arc. fix the one the user already has!"

---

## Evidence {#evidence}

**[F01] The stop was not needed.** The arc was `arc-ask-answers`, at its re-audit, in session `2fc9fbeb-7b88-438d-8966-87e9c3ee3080`. The user typed "fix the keyDown routing in this arc" into the composer at 16:54 UTC; the same stage fixed the red, verified green on rust, deck, proto and app-tests, and re-marked the arc by 17:06. The arc joined as `94d16f519`. **(verified, from the session transcript and `tugtool arc show`)**

**[F02] The doctrine already forbade the ask.** `tugplug/doctrine/arc-work-doctrine.md`: "Never ask whether to fix a red the step surfaced. A failing test has three endings and fixing the code is the default one … The user's question is only ever which of the other two endings, and only when no fix exists." The question offered "fix it" beside two carve-outs. **(verified)**

**[F03] The question's diagnosis was wrong.** There was no keyDown routing defect in the app. `at0523`, `at0525` and `at0633` each kept a local `shellUntil` that typed a `/shell` line straight after `spawnSessionResume`, while the restore gate's modal could still be up; the fix was one shared `shellUntil` in `tests/app-test/arc-fixture.ts` that awaits `restoreSettled`. The stage learned this only after it was told to fix. **(verified, from the stage's own report and the join commit)**

**[F04] Two of the three options would have stranded the user.** "Delete at0523" removes a valid test. "Wait for a fix on main" waits for a fix to an app defect that did not exist ([F03]), and resuming a stage on that answer gives it nothing to do. **(inference from [F03]; neither was tried)**

**[F05] The stage asked because it read a base red as not its own.** Before asking it proved by `tugtool file probe` that the file stayed red with the arc's deck diff reversed, read the memory `at0633-red-on-main` calling it an open defect, ran `tugtool arc verify --help` looking for a way to leave a file out, found none, and asked. The memory index holds many `… red on main` entries and one that says to leave listed files out of a step's selection. **(verified for the sequence of calls; that the memories caused the reading is inference)**

**[F06] The stage did by hand what the record already knew.** Between the red verify and the ask it made about fifteen calls: `tugtool test last --failures`, `just app-test-select`, four `just db-inspect apptest_results` queries, `tugtool apptest history` twice, a solo re-run, and the reverse-diff probe. `tugtool apptest history` already answers whether a file was green before, and since when it has been red; `print_verify` in `tugrust/crates/tugtool/src/arc.rs` prints none of it. **(verified for the calls; that verify prints no history is read from the stage having to fetch it, not from reading `print_verify` line by line)**

**[F07] The ask verb failed twice before it worked.** `tugtool` on PATH was the installed app's and predated `--choice`, so the stage asked without choices; then the shell's `TUG_SESSION_ID` was not the arc's bound seat and the stage had to pass `--session` from its `where` line. **(verified, from the transcript)**

**[F08] What `94d16f519` landed.** `tugtool arc ask` takes a repeatable `--choice "<label>"` (`ArcCommands::Ask` in `tugrust/crates/tugtool/src/cli.rs`); the receipt carries one `choice · <label>` line each; `ArcAskOffer` in `tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx` draws a `TugInlineDialog` titled with the question, with a button per choice, `Reply…` and `Keep Stopped`, and a bare `Resume` only when there are no choices; `tugtool arc answer` writes the answer to the record and the resumed stage's prompt carries it. A choice is a label and nothing else. **(verified)**

**[F09] The app's question dialog is fed by one source.** `QuestionWizard` in `tugdeck/src/components/tugways/chrome/session-question-dialog.tsx` renders a `control_request_forward` event with `is_question: true`; it shows only while that request is the session's `pendingQuestion` (`tugdeck/src/lib/code-session-store.ts`), and `AskUserQuestionToolBlock` hosts it at the tool call's position and morphs to the answered summary. It draws a description per option and a free-text reply, which the receipt's dialog does not. **(verified, from the component's header and the store)**

**[F10] An ask still reads `Stopped` away from the receipt.** The screenshot's Z2 cell reads `0/1 : Stopped` in the error tone, and the notice reads "arc-ask-answers stopped with a question — answer it on its card" (`tugdeck/src/lib/arc-join-register.ts`). The audit of `arc-ask-answers` reported that the compact mark's tooltip, the lifecycle line and the Z2 cell were left saying `Stopped` / `needs a decision`; only the receipt says `Asked`. **(verified for the register line and the audit's report; the tooltip and cell were not re-read after the join)**

---

## Decisions {#decisions}

**[B01] A red at the fit is the arc's to fix, whether or not the base is red too.** The audit and implement skills and the doctrine say so in those words: a red inherited from the base is fixed in the arc that meets it, as ordinary rounds, with no question. This restates [F02] for the case the stage misread ([F05]); "red on the base" is a fact about where the defect came from and never about whose it is.

**[B02] No separate fix arc.** Confirmed by the user. The arc the user already has is the one that gets fixed and becomes joinable. A side arc that joins first would hand the user two arcs to land where they had one.

**[B03] A red verify says whose red it is.** When `tugtool arc verify` ends red, it prints for each red check what the test record holds: whether it was green on the base, since when it has been red, and which other reds fail with the same first line. It closes with the sentence in [B01]. This replaces the forensics in [F06] and takes away the reading in [F05]. The history is advice printed beside the red; it never turns a red green and never leaves a check out.

**[B04] An ask over a red needs a stated attempt.** When the arc's last verify at its head is red, `tugtool arc ask` is refused unless it carries `--tried "<what was attempted>"`, and the refusal quotes the doctrine line in [F02]. Confirmed by the user. It is crude, since a stage can write anything, and that is accepted: its work is to interrupt the stage at the moment it would ask and make it say what it tried. The attempt rides the record and is shown with the question.

**[B05] An ask carries a full decision.** Beside the question and the choice labels of [F08], the verb takes a description per choice saying what happens if it is picked, a mark on the one choice the stage recommends, and what was found, with what was verified kept apart from what is guessed. [F03] and [F04] are the reason: the user was asked to choose on a guess presented as a fact, between options whose outcomes were not stated.

**[B06] The ask is drawn by the app's question dialog, through a second feed.** Confirmed by the user. `QuestionWizard` gains a feed from the arc's record beside its tool-call feed ([F09]), so an arc's question looks and behaves like every other question in the app and sits at the card's live edge. The second feed is a record and not a held turn: it survives a restart, a restored transcript and a rotated session, and nothing waits on it with a turn open. The answer goes through the answer act of [F08]. The user's dislike of the name "wizard" is noted and is not this work's to fix.

**[B07] While an arc's question is up, the composer is the reply.** Text sent from the composer on the asking card is recorded as the answer and resumes the arc, the same as the dialog's own free-text reply. This is what the user did in [F01], and it settles the question `briefs/arc-ask-answers-brief.md` left open about a typed composer turn.

**[B08] The receipt stays the frozen record.** It keeps the question, the choices and, once answered, the answer, and folds as it does today. Whether its own inline buttons from [F08] remain beside the dialog or give way to it is for the arc to settle by what reads best with both on one card; there must be exactly one obvious place to answer.

**[B09] `Asked` in every register.** The Z2 cell, the compact mark's tooltip, the lifecycle line and the notice say `Asked` in the attention tone, never the red `Stopped` ([F10]). An ask is a question waiting on an answer.

**[B10] An asked arc says what stands between it and the join.** The asking card carries one line naming what is left, for example "1 red check · then mark · then join", so each answer is visibly a step toward an arc the user can join.

**[B11] The ask verb works from a stage without hand repair.** A stage's `arc ask` resolves the arc's bound seat itself when the shell's session is not it, and the stage skills call the bundle's own `tugtool` so a flag the plugin documents is one the binary has ([F07]).

**[B12] The `… red on main` memories say who fixes.** Each gains the sentence of [B01], and the entry that says to leave listed files out is scoped to a step's selection, which is where it is true. This is a hand edit to the user's memory directory and not part of the product.

---

## Open Questions {#open-questions}

- **How far [B03]'s history reaches beyond app-tests.** `apptest_results.db` is keyed by the resolved base checkout and answers the question directly. Whether the general test ledger behind `tugtool test last` can say "green on the base" for a unit suite, in any project and under the standalone contract, was not read. If it cannot, [B03] prints what the record has and says nothing where it has nothing.
- **What "the last verify is red" means to the server in [B04].** The mark already refuses over a tree the last verify did not see, so a verify result at a head is on record somewhere; where, and whether `arc ask` can read it without running anything, was not read.
- **The shape of the second feed in [B06].** Whether the question reaches the wizard from the live arc feed entry, from the receipt row, or from a new frame is open; the live arc feed in `tugrust/crates/tugcast/src/feeds/arc.rs` does not appear to carry the question or its choices today. What is fixed is the behaviour in [B06].
- **Several questions in one ask.** The wizard pages through up to four questions. Nothing here needs more than one; whether `arc ask` should ever carry more was not discussed.

---

## Non-goals {#non-goals}

- **A separate fix arc for a base red.** [B02].
- **A way for `arc verify` to leave a known red out.** That is the carve-out the stage went looking for ([F05]). A failing test ends fixed, changed or deleted, and never set aside.
- **`AskUserQuestion` called by a stage.** It stays forbidden for the doctrine's reason: a turn held open is a pause the record cannot see. [B06] borrows the dialog and not the tool call.
- **Renaming the wizard.** Noted by the user as an issue for another time.
- **New exits on the other stops.** A stall, an idle stop and a user's stop keep the receipt they have.
- **Judging the `--tried` text.** [B04] requires the field and reads nothing into it.

---

## Exit {#exit}

**An arc.** Three layers, and the first is the one that removes most stops outright:

- Fix first: the skill and doctrine wording of [B01]; verify's attribution of its reds ([B03]); the `--tried` guard and its refusal ([B04]); the seat resolution of [B11].
- The decision on the record: descriptions, the recommended mark, the found lines and the attempt on `arc ask`, the arc record and the receipt's text ([B05]), carried so that a receipt written by `94d16f519` still reads.
- The card: the second feed into the question dialog ([B06]), the composer as the reply ([B07]), the receipt beside it ([B08]), `Asked` in every register ([B09]) and the line toward the join ([B10]).

[B12] is done by hand, outside the arc.
