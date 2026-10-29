<!-- brief-skeleton v1 -->

# Arc join: legible refusals, a shade that presents, and no resolve nobody asked for

**Purpose:** The arc/join experience in the Changes shade is still a mess: buttons collide, a failed check arrives as a wall of quoted paths, the draft reads too small, and the shade does not present itself when the join needs the user. Underneath, the deck re-runs a four-minute resolve every time the shade is opened on an arc whose last candidate failed its checks.

---

## Purpose {#purpose}

The user's notes, 2026-10-28:

- "Buttons should *never* smash together like this." (the notice band's "Copy details" / "Retry join" pair, touching)
- On the join fold and the report ledger: "Must be like git commit receipt, one file per row." (the stuck line, rendered as a paragraph of shell-quoted paths)
- On the draft: "Text is too small."
- "The Changes shade has *repeatedly* not presented itself when the audit is done and the join is ready."

And, on learning that one arc was resolved five times in twenty-five minutes: "If there were no changes to justify the re-checks, this is madness! Read the log to know why this happened."

---

## Evidence {#evidence}

**[F01] The action buttons collide because the inline dialog forces a width.** `tugdeck/src/components/tugways/tug-inline-dialog.css:254` sets every `.tug-button` in `.tug-inline-dialog-actions` to `width: var(--tugx-idialog-action-w)`, which is `5rem`. "Copy details" at `size="sm"` is wider than 5rem, so its box overflows past the `0.375rem` actions gap into "Retry join". The permission dialog already overrides the same rule for itself (`session-permission-dialog.css:108`). The band also puts two coloured buttons side by side: Copy is `outlined`/`accent`, Retry is `filled`/`danger` (`session-changes-notice.tsx:617–637`). **(verified, read from the code and the screenshot)**

**[F02] The stuck sentence is a shell command with every selected path quoted into it.** `first_reds` in `tugrust/crates/tugarc-core/src/surfaces.rs:664–683` formats a failed check as `"{surface}: `{command}` (exit {code}){ · first red title}"`, and `command` is the check template after `expand` (`surfaces.rs:136`) has substituted the shell-quoted path list into it. That one string is written as the durable stuck line (`record_join_stuck`, `changeset.rs:2602`) and as the ledger's `ended` event detail, and the deck shows it three times with no structure: the fold's refusal band (`BlockNoticeBand`, eight-line clamp, `session-changes-arc-join.tsx:724`), the ledger's `ended` row as `session-changes-ledger-words` prose, and the candidate's identity line as `withheld — …` (`resolve-ledger.test.ts:396`). For the app-test check the `first red` title is absent, so the reader gets twenty file names and no red. **(verified)**

**[F03] The draft reads at the shade's small scale.** The draft wears `tugx-commit-receipt tugx-commit-landing` (`session-changes-arc-brief.tsx:506`); the landing scale sets the message to `--tug-font-size-sm` (13px) and leaves the subject at `xs` (12px) (`commit-presentation.css:51, 93`). The composer beneath shows the same words larger. **(verified)**

**[F04] The shade presents only on an offer, and a withdrawn candidate is not an offer.** The reveal effect in `session-card.tsx:3309–3349` runs on `joinOffer`, and `standing_offer` in `tugrust/crates/tugcast/src/feeds/join_board.rs:458` returns `None` while the board's `withheld` reason is `no-candidate`, `run-held`, `question` or `stuck` (`join_board.rs:271–281`). `tugcast.log.2026-10-28` for the release instance shows three arcs go ready and never offer: `restore-gate-session-count` (14:40–15:05), `arc-crossing-lab` (16:59–17:04) and `remove-join-candidate-exam` (17:55–18:01) cycle through `withheld no-candidate` → `withheld run-held` → `candidate withheld … failed its checks` → `withheld no-candidate` with no `offered` and no `landing-receipt kind=reveal`. The one arc that did offer (`arc-join-face`, 2026-10-29T00:32:06Z) revealed within two seconds and was joined fifteen seconds later. **(verified, log)**

**[F05] Two smaller reveal failures are silent.** `moved-call-is-a-job` on 2026-10-27T14:27:29Z was deferred `composer-busy` and no later receipt followed. `handback-fixups` (02:05:53Z) and `app-help` (23:03:20Z) were offered a second time after a `no-candidate` spell at the same work id; the gate answers `already-shown` for those, and `JoinOfferRevealReceipts.due` (`join-offer-reveal.ts:180`) deliberately logs nothing for that reason. **(verified, log and code)**

**[F06] Only the first of the five resolves was the pilot; the other four were the deck's join-mode entry.** The log carries one `join-pilot: running` line for `restore-gate-session-count`, at 14:41:01Z. The later ladders at 14:48:30Z, 14:52:17Z and 14:55:23Z have no pilot line; the 14:52 one is preceded within a second by a `button.tug-choice-group-segment took activeElement` focus correction, which is the Changes segment being clicked. `JoinModeController.enter` calls `ensureCandidate` (`join-mode-controller.ts:666`), which sends a resolve whenever the arc is `clean`, has no candidate string, and has no live run. It never reads the standing stuck line. After a failed check the candidate is withdrawn, so every entry into the shade on that arc sends a fresh ladder, and each ladder runs the full `just app-test-changed` check, three to four minutes. **(verified, log and code)**

**[F07] The join's check is the derived app-test selection over the arc's whole diff.** The failing check in every withheld line is `deck: `just app-test-changed <paths…>``. The selection carries files the app-test history already records red at the base, so a candidate can be withdrawn by a red that is not the arc's. **(verified for the check; the base-red share is inference from the standing base-red list in memory, confirmed by whichever file the report names first once [B02] lands)**

---

## Decisions {#decisions}

**[B01] The inline dialog's action buttons take a minimum width, not a fixed one, and a band carries one accent.** `--tugx-idialog-action-w` becomes `min-width`, so a short pair still balances and a long label can never overflow into its neighbour. In the notice band Copy is a quiet outlined button with no role colour and Retry is the one filled button. Fixing it in the primitive rather than the band is what lets the permission dialog's override go too.

**[B02] A failed check is structured at the source and rendered with the receipt row grammar, one path per row, by one component in both seats.** The check result carries surface, command head (the template before `expand`), the paths, exit code and first-red title as fields; the stuck line and the ledger's `ended` event carry that structure rather than a sentence. The deck renders a sentence row ("the candidate failed its checks: deck ran `just app-test-changed`, exit 1, first red …") followed by one `arc-fold-path` row per file, the same block in the join fold and in the resolve ledger. The resolver reads the app-test report's first failure (its `Failures:` section or `TUG_APPTEST_JSON`) so the title is never empty for that check. The old single-string detail stays readable for ledgers written before this lands.

*Superseded by `audit-relative-readiness-brief.md` [B08]: the join lost its ladder, so there is no stuck line, resolve ledger or join-time check to structure.*

**[B03] The landing scale is `md` for subject and message alike.** What you are about to sign reads at the size you would write it, matching the composer. File rows under it keep their size.

**[B04] The shade reveals on "this arc needs you", not on "this arc has an offer".** The board publishes one attention fact per ready arc: `offer`, `stuck` or `question`, with a key that changes when the stuck line or question changes, and never while a run is live. The reveal effect and the spend memory key on that attention key, so a new stuck line after a seen offer is new work. A withdrawn candidate is the moment the decision becomes the user's, and that is exactly when the room opens.

*Superseded by `audit-relative-readiness-brief.md` [B08]: with no stuck line or question on the board, the attention fact is the offer alone.*

**[B05] Every reveal verdict is logged, and a hold either resolves or goes.** `already-shown` gets a receipt like the others, since it is the one silent case. The `composer-busy` hold is dropped: a composer with text in it is not a reason to keep a ready join out of sight, and the effect had no reliable re-arm on it.

*Superseded by `audit-relative-readiness-brief.md` [B08]: the reveal reads the offer; the stuck and question re-asks it was written for are gone.*

**[B06] The join check stays `just app-test-changed` over the arc's whole diff, minus files the app-test history records red at the base.** The resolver asks `tugtool apptest history` for each selected file and drops the ones red at the base before the arc touched them, naming them in the report as left out. A red that was red before the arc is not the arc's verdict to carry.

*Superseded by `audit-relative-readiness-brief.md` [B08]: nothing is checked at join time; the audit verifies the fit.*

**[B07] No automatic resolve while a stuck line stands or the last run ended without a candidate at the same head pair.** `ensureCandidate` reads the stuck line and the last ended run's head pair before sending, and the pilot keeps its existing stop. Only the explicit Resolve again press, or a head move on either side, re-runs. A glance at the shade is not consent to a four-minute check.

*Superseded by `audit-relative-readiness-brief.md` [B08]: there is no automatic resolve left to hold — `ensureCandidate` and the pilot are gone.*

---

## Non-goals {#non-goals}

- **Dropping app-tests from the join check.** Considered and rejected by the user: the whole-diff check is right; the base reds are what is wrong.
- **Keying the reveal on a client-side list of hold reasons.** The seven-hold gate is kept as the quiet-moment rule for an unbidden reveal; what changes is what it reveals on ([B04]) and that every answer is logged ([B05]).
- **Reworking the pilot.** The pilot ran once and stopped as designed ([F06]); it is not the sender.

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land: structure the check result and the stuck line on the server ([B02]), then the shared refusal block in the fold and the ledger; the resolve guard in `ensureCandidate` ([B07]) and the base-red subtraction ([B06]) can land beside that; then the attention fact on the board and the reveal keyed on it ([B04], [B05]); the dialog width, the band's accents and the landing scale ([B01], [B03]) are independent and can land at any point.
