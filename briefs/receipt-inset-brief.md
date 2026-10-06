# Receipt Inset

**Purpose:** The transcript's receipt and response surfaces each set their own inner padding, so a question's answer, an arc's stop receipt, and Claude's own `git commit` sit at different insets from the `/commit` receipt beside them. Make every one of them match.

---

## Purpose {#purpose}

The user's report: "When I answer a question or answer in chat in an AskUserQuestion/InlineDialog flow, the response in the transcript needs to get the same margin/padding as a git commit. It doesn't." Then, widening it: "It's not only inline dialogs, it's every one of these response/receipt surfaces in the transcript."

The reference is the main-lane `/commit` receipt (`session-commit-receipt-block`): a `Git Commit` row whose body is the message well and the file rows, inset evenly from the frame on both sides.

---

## Evidence {#evidence}

All findings below were read out of the CSS and component source. No pixel measurement was taken in the running app; that is what the arc's verification will do.

**[F01] The frames already agree; only the inside differs.** Every framed block in the transcript — shell row, git row, wheel row, or a tool block in an assistant turn — sits in the entry body column at `--tugx-transcript-body-inset` (`tug-transcript-entry.css`, re-derived on `.session-card-transcript` in `session-card.css`) with the same `BlockChrome` frame and header strip. The chrome's body region carries no padding of its own; each body kind states its own. **(verified)**

**[F02] The reference inset is compact-row + gutter inline, `sm` block.** `.tugx-commit-message` (`commit-presentation.css:148-162`) pads both inline edges with `calc(var(--tugx-list-row-padding-inline-compact) + var(--tugx-list-row-indicator-gutter))` = 8px + 0.2rem ≈ 11.2px (`tug-list-row.css:74,79`), which lines the message up with the compact `TugChangesList` file rows beneath it. The detail slot pads block-only with `--tug-space-sm` = 6px (`session-commit-receipt-block.css:59`). **(verified)**

**[F03] Push, join and discard receipts already match the reference — by repeating the calc, not by sharing a token.** `[data-slot="push-receipt-detail"]` (`session-push-receipt-block.css:46`), `.join-receipt-identity` and `[data-slot="join-receipt-detail"]` / `[data-slot="discard-receipt-detail"]` (`session-join-receipt-block.css:39-69`) each restate the same values. The discard receipt's inline inset is inherited from the shared message well and was not checked on screen. **(verified from source; discard not checked on screen)**

**[F04] `.arc-receipt-body` is off.** `session-arc-receipt-block.css:51` pads `var(--tug-space-sm) var(--tug-space-md) var(--tug-space-md)` — 6px top, 8px sides with no gutter, 8px bottom. Two surfaces wear it: the `/arc-run` stop / pick-up receipt (with its `TugInlineDialog` Resume offer) and the opened `Joined` boundary's arc record (`session-join-receipt-block.css:72-76` says so). **(verified)**

**[F05] Claude's own `git commit` renders a different body under the same name.** `bash-tool-block.tsx:417` renders `CommitBlock` (`body-kinds/commit-block.tsx`) under `toolName="Git Commit"`. Its root `.tugx-commit` pads `var(--tug-space-sm) var(--tugx-filerow-inset)` = 6px / 8px (`commit-block.css:27`), and its message is a `BlockDisclosure` labelled "message" over a `.tugx-commit-body` of lines — not the receipt's `.tugx-commit-message` well. The `/commit` receipt and this block name the same act and lay it out differently. **(verified)**

**[F06] The answered-question record is inset further and stands taller.** The rows are the shared `QuestionSummaryList`, padding `14px + 0.2rem` start / `14px` end / 8px block per row (`question-summary-list.css:64-91`, falling back to `--tugx-list-row-padding-inline` = 14px). Above them `.ask-user-question-tool-block-summary` reserves a 24px (`--tug-button-xs-height`) box with 8px margins top and bottom, and the list adds an 8px tail (`ask-user-question-tool-block.css`). The reservation exists only to hold the rows still as the live wizard's action bar morphs into the record. **(verified)**

**[F07] The other question states are inset less.** `.ask-user-question-tool-block-declined` ("Chat about this" → "Replied in chat" + the reply verbatim), `.ask-user-question-tool-block-salvage` (inline recovery when Claude Code's validator rejected the call) and `.ask-user-question-tool-block-empty` each pad `--tug-space-md` (8px) on all sides, no gutter. **(verified)**

**[F08] The live wizard shares the record's horizontal geometry.** `session-question-dialog.css:131-160` places the nav summary at `14px + gutter` and pulls the button cluster in by `14px` at the end, matching the summary rows so the wizard → record morph holds the rows still. The live wizard and the record mount in the same `BlockChrome` with `rootSlot="ask-user-question-tool-block"` (`ask-user-question-tool-block.tsx:504`). **(verified)**

**[F09] The frameless one-line rows are already consistent.** Arc notes and the arc `Finished` line (`.session-card-transcript-quiet-row`, `session-arc-note-block.css:54`), Tug notices (`SessionNoticeLine`), run markers, wake-trigger chips and the session boundaries all start at `--tugx-transcript-body-inset`. They have no frame, so the inner inset does not apply to them. **(verified)**

**[F10] Command output uses its own 8px inset.** `shell-exchange-block.css` and `refs-result-block.css` set no inner padding; the terminal and the file-row grammar (`--tugx-filerow-inset` = `--tug-space-md`, `tugx-block.css:233`) supply 8px, no gutter. **(verified)**

**[F11] The permission dialog and the app-test ask dialog leave no transcript record.** Both are pending-only (`session-permission-dialog.tsx` docstring; `session-app-test-ask-dialog.tsx`); the Changes shade's notice band and the blocked arc-join dialog render in the Changes shade, not the transcript. **(verified)**

---

## Decisions {#decisions}

**[B01] The `/commit` receipt's inset is the one inner inset for every framed receipt and response surface in the transcript: compact-row padding + indicator gutter inline, `--tug-space-sm` block.** It is the surface the user named as correct, and push and join already match it ([F03]). Every surface in [F04]–[F07] moves to it.

**[B02] The inset becomes a named token pair in `tugx-block.css`, and every receipt reads it.** Something like `--tugx-block-receipt-inset-inline` (the compact + gutter calc) and `--tugx-block-receipt-inset-block` (`--tug-space-sm`). The receipts that already match ([F03]) agree by repeating a calc in several files; one token turns that coincidence into a single source, so the next receipt cannot drift. `.tugx-commit-message`, `.join-receipt-identity` and the `*-detail` slots switch to reading it with no visible change.

**[B03] `.arc-receipt-body` takes the token pair on both axes.** One rule fixes both the arc stop receipt and the opened `Joined` boundary ([F04]), and lines the Resume offer and stage rows up with the join receipt above them.

**[B04] Claude's "Git Commit" block adopts the receipt's message layout, not just its padding.** Agreed with the user. It is the same act under the same name as the `/commit` receipt ([F05]); two layouts for one commit is the inconsistency being fixed. The block's message renders in the `.tugx-commit-message` well at the receipt inset in place of the "message" disclosure over `.tugx-commit-body`, and `.tugx-commit` takes the token inset. The History shade's own use of the commit presentation stays as it is (see Non-goals).

**[B05] Inside the question block, the summary rows take the compact inset by a scoped override, not by changing `QuestionSummaryList`'s defaults.** Set `--tugx-qrow-pad-inline` (and with it the end edge) on `[data-slot="ask-user-question-tool-block"]`. The shared list's base values stay for its other hosts. Because the live wizard mounts under the same slot ([F08]), its nav summary and button-cluster end margin move with it, so the wizard → record morph still holds the rows still horizontally.

**[B06] The "N of N answered" summary line stays, made smaller.** Agreed with the user. It drops the 24px reserved box and its 8px margins: it starts at the 6px block inset and takes its own line height, and the list's 8px tail goes so the last row ends on the 6px bottom inset. The record no longer has to match the live wizard's vertical geometry — once the buttons are gone the record is allowed to be shorter; only the horizontal morph is load-bearing.

**[B07] The declined, salvage and empty question states take the token pair.** Replacing their 8px padding on every side ([F07]) lines the "Replied in chat" text up with the answered rows and with the commit message.

**[B08] The frameless rows and command output stay as they are.** The quiet rows already agree with each other at the body column ([F09]); command output is code and file rows with their own grammar ([F10]), not receipt prose.

---

## Non-goals {#non-goals}

- **Changing the frames' outer placement.** It is already shared ([F01]); this work is the inside of the frame only.
- **Restyling the History shade's commit rows.** They share `commit-presentation` vocabulary, but the shade keeps its own layout (including the hanging indent `session-commit-receipt-block.css` notes it keeps). [B04] changes the transcript block only.
- **Changing `QuestionSummaryList`'s base defaults.** It has hosts outside the transcript; the override is scoped ([B05]).
- **Shell exchanges and `/match`/`/search` refs.** Considered and left out: they are 3px short of the receipt inset, but their content is terminal output and file rows, not receipt prose ([B08]).
- **The permission and app-test ask dialogs, the Changes shade notice band, the blocked arc-join dialog.** None leaves a transcript record ([F11]).
- **Dropping the "N of N answered" line.** Considered; the user chose to keep it, smaller ([B06]).

---

## Exit {#exit}

An arc. A natural order:

1. Add the token pair to `tugx-block.css` and point the already-matching receipts at it (commit, push, join, discard) — no visible change, which makes it the safe first step.
2. Move `.arc-receipt-body` to the token ([B03]).
3. Rework Claude's "Git Commit" block onto the `.tugx-commit-message` well at the token inset ([B04]).
4. Rework the question block: scoped row-inset override shared by live wizard and record, smaller summary line, declined / salvage / empty states on the token ([B05]–[B07]).

Verification: `just app-test-select` over the changed CSS, taking the union with any question, arc-receipt and join-boundary position tests. The test for the wizard → record morph must keep asserting that the rows hold still horizontally ([B05]); its vertical expectation moves with [B06], and that change is the decision recorded here. The `.tugx-commit` gallery and the History shade get checked by eye to confirm [B04] stayed inside the transcript.
