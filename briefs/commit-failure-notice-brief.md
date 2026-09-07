<!-- brief-skeleton v1 -->

# Commit failure notice — the refusal speaks at the seam

**Purpose:** When git refuses a `/commit`, the Session card reports it as a sticky corner bulletin that the Changes shade's scrim dims, at the top of the card, as far from the pressed button as the card allows. The refusal should speak where the commit happened: between the files in the shade and the message in the composer.

---

## Purpose {#purpose}

The report, from a real failure on 2026-09-05 (`index.lock` held by another git process while `/commit` ran):

> This is an unacceptable way to report this commit error. We need to figure out how to do better. Somehow, the error must not be behind the scrim. It should also be tied more closely to the changes shade and the commit message entry component, and not up at the top of the page where it is too far away from the action the error addresses. … We don't actually have a good design for this kind of message.

The `spike-commit-failure-notice` spike put four stages side by side — what ships, and three seats for the notice. The user chose **A · Seam**, and added a constraint on the work that follows: the spike's mock was *very loose*, and the real work has to hew far more closely to the details of the actual shade, composer, and alert designs. That constraint is recorded here as a decision, not a remark.

---

## Evidence {#evidence}

**[F01] The failure path ends in the corner bulletin lane.** A `changeset_commit_err` reply lands in `changeset-verb-store.ts` as commit phase `error` with git's stderr as `detail`; `CommitModeController` publishes it as `landError`; `landingNoticeDecision` (`lib/landing-notice.ts`) turns it into a `post` titled `"Commit failed"` with the raw detail as description; `LandingNoticeController` applies it as `api.danger(…, { sticky: true })` on the `TugPaneBulletinProvider` with `placement="top-right"` in `session-card.tsx`. **(verified — read out of the code)**

**[F02] The shade's scrim covers that lane.** The Changes shade is a `TugSheetContent presentation="shade"` with `shadeAnchor="bottom"` and `modalScopeSelector` on the transcript pane; it raises the pane scrim over the transcript region. The bulletin toaster is `position: absolute; z-index: 90` inside `.tug-pane-bulletin-root`, which is `isolation: isolate`, so its stacking never escapes its own root and the pane's scrim layer paints over it. The screenshot shows the notice dimmed; the spike's first stage reproduces the geometry with the real provider and a scrim sibling. **(verified in the spike; the exact layer order in the live card is read from CSS and the screenshot, not measured)**

**[F03] The mode already brings the user back to the commit surface on failure — and then speaks somewhere else.** `performCommit` in `commit-mode-controller.ts` re-enters the mode (and so the shade) when the round-trip settles in `error` after the staged dismissal left it, with the comment "so the error surfaces where the user acted." The surface it then uses is the corner lane. The intent is already in the code; only the seat is wrong. **(verified)**

**[F04] The message survives a failure.** The commit message is durable in the changeset draft store (debounced `persistMessage`), and only a `done` round-trip clears it. A retry after a failure is a press of the same button over the same text. **(verified)**

**[F05] The entry region already has a seat for composer-side strips.** `.session-card-entry-region` holds `.session-card-entry-pane`, whose first child is `SessionPendingContextStrip` — a strip "at the top of the composer pane" that self-hides when empty — followed by the `TugPromptEntry`. The entry shell itself (`tug-entry-shell.tsx`) renders an optional `statusRow` as its first child, above the input area; that row is `white-space: nowrap`, ellipsized, muted, one line. The shade's bottom edge is the top of the entry region ("the column ends exactly where the entry region begins"). So the seam between shade and composer is a real place in the DOM with an occupant already. **(verified)**

**[F06] The words are git's, and the only act is OK.** The title names the verb the user just pressed; the body is stderr verbatim ("fatal: Unable to create '/u/src/tug/.git/index.lock': File exists. Another git process seems to be running…"); the sticky bulletin's one control is a dismiss labelled OK. Nothing retries, nothing copies, nothing says what to do. **(verified)**

**[F07] `landError` has no acknowledge path.** `clearCommit` on the verb store is the only reset and nothing in the deck calls it outside the store; the error is overwritten only when the next commit round-trip sets a new phase. A notice keyed on it therefore stands until the next press — which is the right lifetime, but it means a dismiss affordance is a local hide, not a state change. **(verified by grep)**

**[F08] Both landing modes share the controller.** `LandingNoticeController` is generic over `LandingMode`; the card mounts one for commit and one for join. Both channels — `landError` (server refused a landing that went out) and `landRefusal` (this deck refused to send one; `gate` fades as caution, `fault` sticks as danger) — go to the same lane. Whatever seat commit gets, join gets, and both channels come with it. **(verified)**

**[F09] `TugInlineAlert` is the right face and is deliberately inert.** It draws the alert family's icon / bold title / message layout from the shared `tugx-header` scale with a tone that warms only the border, renders an `actions` row bottom-right, and owns no responder, focus, or dismiss machinery — "a caller who wants buttons composes real `TugPushButton`s into `actions` and wires their own focus / roles / handlers." It has no dismiss X of its own. **(verified)**

**[F10] The spike's mock is loose and is not the spec.** The spike hand-drew the shade header, the file rows, the section label, the disclaim foot, the commit-message editor, the route toggle, the chips, and the composer footer in its own `.sp-cfn-*` classes; only the notice (`TugInlineAlert`, `TugPushButton`, `TugIconButton`) and the shipped bulletin were real components. It shows *where* the notice sits and *what it says*. It does not show the real shade's geometry, the real entry shell's rows, the real Z5, or the real densities and tokens. **(verified — it is what I wrote)**

---

## Decisions {#decisions}

**[B01] A landing failure speaks at the seam: in the entry region, below the shade's bottom edge and above the composer.** The modal-rest-line doctrine already exempts the Changes shade from the rest line because the shade and the message editor below it are one gesture ([D117]). A refusal of that gesture is part of it, so it belongs *on* the gesture. The seam is inside the gesture, outside the scrim by geometry rather than by z-index, and one gutter from the button that was pressed. This rules out the corner lane for landing failures and rules out any z-index fix that would keep the notice there. It would be revisited only if the shade stopped resting on the entry region.

**[B02] The seat is a composer-side strip in `.session-card-entry-pane`, the seat `SessionPendingContextStrip` already holds — not the entry shell's `statusRow`, and not inside the shade.** The `statusRow` is a one-line, `nowrap`, muted row inside the shell; it cannot hold a title, a remedy, folded evidence, and two acts, and it is inside the composer rather than between the composer and the shade. Inside the shade, the notice would scroll with the file list and sit under the rows rather than over the button. The strip seat is exactly the seam ([F05]), and it has a precedent that self-hides when empty, which is the notice's common state. The devise round confirms the strip's order relative to the pending-context strip (the notice above it, nearest the shade) and that the shade's `shadeAutoSize` geometry is unaffected by a strip that appears and disappears beneath it.

**[B03] The face is `TugInlineAlert` with `tone="danger"` and `live="alert"`, composed in the card's real chrome — never a bulletin, never a modal.** The composer keeps focus; nothing traps, nothing scrims, nothing blocks. The alert's own tokens and the `tugx-header` scale are the typography; the actions are `TugPushButton`s in its `actions` slot wired through the responder chain like every other control in the entry region ([L11]). A dismiss control, if kept, is composed alongside it (the card-header idiom, a `TugIconButton` at the trailing edge), because the alert has none of its own ([F09]).

**[B04] The words: the title names the cause in the user's frame, the message names the remedy, and git's own stderr is kept, folded, and copyable.** "Commit failed" tells the user what they already know. For the reported case: title "Another git process is holding the repository lock"; message "Tug couldn't take .git/index.lock. If nothing else is running git here, remove the lock file and try again — your message is kept." Git's text is the evidence and stays one disclosure away. A small table covers the refusals git actually produces (lock held, identity unset, hook refused, nothing to commit); anything unmatched falls back to git's first line as the title with the rest folded. The decision of *what* to say stays in `landingNoticeDecision` — the pure function that already exists and is already tested — extended to carry a structured cause; the projection is what changes.

**[B05] The acts are Retry commit, Copy details, and dismiss; Retry is the land button.** Retry sends the same message again, which is what the land button already does ([F04]) — so the alert's Retry and Z5's Commit are one act with two doors, and Return still lands it. While the notice stands, the land button's tooltip and label read "Retry commit" so the two doors agree. Copy details writes the title, the remedy, and git's full text. Dismiss hides the notice locally ([F07]); it does not clear the error, and it does not exit the mode.

**[B06] Lifetime: the notice stands until the next land press or the mode's exit; a second failure replaces it in place; it never auto-dismisses and never blocks.** A refusal is something the user must read, so it does not fade. It is about *this* press, so the next press takes it down (the pending round-trip replaces it) and leaving the mode takes it down. The join landing's gate refusals, which fade today as caution, keep fading — they are the deck saying "not yet," and the user can see the condition — but they fade from the same seat.

**[B07] Both landing modes and both channels move together.** `LandingNoticeController` stays generic over `LandingMode` and both `landError` and `landRefusal` are projected onto the seam ([F08]). Join inherits the seat for free. The corner lane keeps what the modal-rest-line doc already gives it: notices with no card grain to obey. The doctrine gets one sentence saying so, and the `LandingNoticeController` docstring stops naming the pane bulletin.

**[B08] The real work hews to the actual designs; the spike is the concept, not the drawing.** Nothing in the spike's `.sp-cfn-*` stylesheet is production styling, and none of its mocked chrome may be carried forward ([F10]). The plan's steps compose the real `TugSheetContent` shade as mounted in `session-card.tsx`, the real `TugPromptEntry` / `TugEntryShell` and its Z5, and `TugInlineAlert`'s own tokens and spacing; densities, gaps, and type come from those components, not from the spike's approximations. Where a value has to be chosen — the strip's inset against the shade's bottom edge, the gap to the composer — it is read from the neighbours it sits between (`session-pending-context-strip.css`, the entry pane) rather than invented. The spike is deleted when the plan lands, with its findings carried into `tuglaws/modal-rest-line.md`.

---

## Open Questions {#open-questions}

- **Where the translation from git's stderr to a cause lives.** Either tugcast recognizes the failure and ships a structured `cause` beside `detail`, or the deck matches on the text in `landingNoticeDecision`. Server-side is one place and one language for every client; deck-side needs no protocol change. The devise round settles it by reading how `changeset_commit_err` is produced in tugcast and whether the join path (`changeset_join_err`) fails through the same seam.
- **Whether the pending-context strip and the failure notice can both be up.** Staged context rides a `❯` submission, not a landing, so in commit mode the pending strip may already be hidden. If it can show, the order and the combined height need a decision; if it cannot, the seat is uncontested.
- **Whether a gate refusal ("Write a commit message", "Wait for the turn to finish") belongs in the seam at all, or stays on the land button's tooltip.** The button already carries the sentence as its tooltip. Doubling it in the seam may be noise; the devise round decides after seeing the two together.

---

## Non-goals {#non-goals}

- **B · the composer's status row.** One line, `nowrap`, inside the shell; no room for a remedy or a second act, and inside the composer rather than between it and the shade. Rejected in the spike.
- **C · the shade's foot.** Ties the notice to the list, which is not what failed; scrolls away with a long list; farthest from the button. Rejected in the spike.
- **Lifting the bulletin over the scrim.** A z-index fix would keep the notice at the top of the card, over a transcript it has nothing to do with, and would make the scrim lie about what is modal. The seat is wrong, not the layer.
- **A modal `TugAlert`.** A commit failure is not a decision the user must make before doing anything else; it is a refusal of one press. Blocking the card to say so would be worse than the corner lane.
- **A durable transcript row for a failed commit.** A failed commit changed nothing; it is ink in motion, not ledger. The seam notice vanishes with the state that made it, and a replayed transcript shows nothing of it — the same terms as the join register's live narration.
- **Changing what the corner lane is for.** Transient notices with no card grain (copy confirmations, API retry) stay where they are.

---

## Exit {#exit}

**A plan.** Its first steps are: extend `landingNoticeDecision` to emit a structured notice (cause title, remedy, raw detail, tone, acts) with the existing tests carried and the translation table added; write a `SessionLandingNoticeStrip` (name to be settled) in `components/tugways/cards/` that reads the landing snapshot through `useSyncExternalStore` and renders `TugInlineAlert` with chain-wired `TugPushButton`s, mounted in `.session-card-entry-pane` above the pending-context strip; retarget `LandingNoticeController` — or retire it in favour of the strip — so nothing landing-shaped reaches the top-right provider; relabel Z5 while a failure stands; delete the spike and amend `tuglaws/modal-rest-line.md`. The phase boundary is the first strip rendering a real `index.lock` failure in the real card with the shade up; everything after it — the translation table's breadth, join's inheritance, the gate-refusal question — is the second phase.
