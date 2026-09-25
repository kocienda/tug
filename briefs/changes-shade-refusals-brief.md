<!-- brief-skeleton v1 -->

# Changes-shade refusals — nothing behind the scrim, everything in the shade

**Purpose:** A gesture made from the Changes shade can still be refused into the card's corner bulletin lane, which the shade's own scrim dims. That route has to go away entirely — not be avoided by one caller at a time — and every refusal of a shade gesture has to speak inside the shade, the way a blocked join already does.

---

## Purpose {#purpose}

The user, on a screenshot of a `/commit` refused with "hunk election needs a clean index; these paths are already staged" — reported as a sticky "Commit failed" bulletin floating over the dimmed transcript, with an OK button, while the Changes shade stood open below it:

> When a commit fails, it can't show a bulletin behind the scrim. Not ever. We should remove the code and support to even do so, and once we do, we need to put the error and dialog *in the Changes sheet*.

And, on the first sketch, which had kept the seam strip and treated the move as several separate questions:

> We need a complete removal of the behind-scrim interactions that stem from the Changes shade. In its place, we need to build in a way to have this interaction be *within* the Changes shade itself. We already do this for join failures, don't we?

The answer to the last question is yes, and it is the whole shape of the work.

---

## Evidence {#evidence}

**[F01] The commit case in the screenshot is a pre-fix build; the corner-lane route for commit is already gone.** The session in the screenshot (`dash+join-xp`) was last updated 2026-08-28. `a03420c79` (2026-09-07, `tugarc/commit-failure-notice`, from `briefs/commit-failure-notice-brief.md`) deleted `landing-notice-controller.tsx` — the projector of `changeset_commit_err` onto the pane bulletin — and seated the refusal in `SessionLandingNoticeStrip`, the entry pane's first child, in the seam between the shade's bottom edge and the composer. **(verified** — `git show --stat a03420c79`; the strip is at `tugdeck/src/components/tugways/cards/session-landing-notice-strip.tsx`.)

**[F02] The capability was not removed; one caller was.** The corner lane — `TugPaneBulletinProvider placement="top-right"` at `session-card.tsx:4640` — is fully live, still sits in the transcript region the shade's scrim covers, and six zero-render controllers still post into it. Four of them report refusals of gestures made *inside* the shade: `claim-error-notice-controller.tsx` (Claim / Disclaim on a file row), `discard-error-notice-controller.tsx` (Discard on an arc row), `arc-press-notice-controller.tsx` (Start / Resume / Stop on the arc lane), `arc-replay-notice-controller.tsx` (replay outcomes on the arc lane). Two more report gestures whose usual posture is shade-up: `draft-error-notice-controller.tsx` (Auto-Message) and `arc-bind-error-notice-controller.tsx` (`/arc <name>`). Every one of these lands exactly where the screenshot's commit failure did. **(verified** — grep of `TugPaneBulletinProvider` mount sites and the controllers' headers.)

**[F03] The seam strip is not in the shade.** `SessionLandingNoticeStrip` sits in `.session-card-entry-pane`, below the shade. `briefs/commit-failure-notice-brief.md` [B02] rejected "inside the shade" on the ground that a notice there "would scroll with the file list and sit under the rows rather than over the button" — an argument about a *scrolling* seat, which a fixed band under the header does not have. **(verified** — the strip's docstring and the prior brief.)

**[F04] The shade already hosts a refusal as a dialog: the blocked join.** `session-changes-arc-join.tsx` renders each join blocker as a `TugInlineDialog` — icon, title, remedy sentence, one Resolve action — the same primitive `PermissionDialog` and `QuestionDialog` are built on, because "a refusal with one act to clear it *is* a dialog and Tug has that vocabulary already" (its own docstring). It takes no key view; the shade stays passive ([P17]) and the composer keeps focus. **(verified** — read the file.)

**[F05] The words already exist and are pure.** `landing-notice.ts` — `COMMIT_CAUSES` (lock held, identity unset, hook refused, nothing to commit, hunk drift, already staged) and `describeLandingFailure` — decides title, remedy, and folded detail from git's stderr with no knowledge of where it renders, and is pinned by `landing-notice.test.ts` against real stderr. `LandingMode.retry()` exists on both mode controllers as `land()` over the live message, and the land button already reads "Retry commit" while a refusal stands. **(verified.)**

**[F06] The doctrine names the seam, not the shade.** `tuglaws/modal-rest-line.md:60` says a refusal of the Changes gesture "speaks on it — `SessionLandingNoticeStrip`, in the entry region under the shade's bottom edge"; line 78 says the corner lane "carries nothing landing-shaped." The second sentence is a rule about one shape of notice, enforced by prose only — [F02] is six standing violations of its spirit. **(verified.)**

**[F07] `at0530` pins the seam geometry.** `tests/app-test/at0530-commit-failure-speaks-at-the-seam.test.ts` asserts the strip's box sits between the shade's and the editor's, and that the corner lane is empty of anything commit-shaped. Moving the seat means re-pinning the first assertion; the second is the tripwire this work generalises. **(verified.)**

---

## Decisions {#decisions}

**[B01] Every refusal of a gesture that starts in the Changes shade speaks inside the Changes shade.** The shade is the commit surface ([D117]); a refusal of something done on it belongs on it, in the user's line of sight, not in a lane the shade's scrim dims and not in a seam below it. This supersedes `commit-failure-notice-brief.md` [B01]/[B02]: the seam was a half-measure that fixed one caller's seat and left the lane open to the rest ([F02]). It rules out any z-index or opacity fix that would keep the corner lane in play, and it rules out keeping the seam strip for commit and join alongside a shade seat for the others — one seat, or the same distance mistake at two distances.

**[B02] The corner-lane route is removed, not avoided: the six controllers in [F02] and `SessionLandingNoticeStrip` are deleted.** "Not ever" is a fact only when there is no code to do it. With the posters gone, nothing that starts in the shade can end in the corner lane, and a future `api.danger()` written from a shade verb has no precedent to copy. The pane-bulletin provider itself stays — it still carries `TransientNoticeController`, the attachment-error caution and the privacy refusal, none of which are shade gestures — but a tripwire ([B06]) makes the lane's emptiness while the shade is presented a tested fact rather than a docstring's promise.

**[B03] The seat is one `SessionChangesNotice` band, fixed under the shade's header and above its scroller.** Fixed is what answers the prior brief's objection ([F03]): it does not scroll with the rows, it is visible wherever the list is, and it is one place for every refusal the shade can produce. The header's own cluster (labels, fold-all, pop-out, X) is untouched; the band is the body's first child and renders nothing when there is nothing to say, the same self-hiding the strip had.

**[B04] The face is `TugInlineDialog`, exactly as the blocked join renders it ([F04]).** Tone icon, title in the user's frame, remedy sentence, git's verbatim detail folded and copyable, and the one act the refusal admits — **Retry** for a server-refused commit or join (`LandingMode.retry()`, [F05]), **Dismiss** for everything else. Not a bulletin, not `TugAlert`: it takes no key view, so the shade stays passive ([P17]) and the composer keeps focus. Claim, disclaim, discard, draft, arc-press, arc-replay and arc-bind refusals seat in the same band with their own title and detail and no Retry; their stores and subscriptions are unchanged — the words move, the plumbing does not.

**[B05] A commit or join refused while the shade is closed raises the shade to say so.** The shade is where the refusal speaks ([B01]); a refusal with nowhere to appear is the silent-dead-button failure the arc verbs have already paid for once ([L31]). Opening the shade is what the commit itself would have shown the user had it landed, so it is not a surface moving on its own. A gate refusal the deck makes before sending (`landRefusal`) keeps its current behaviour of standing briefly and fading, from the band.

**[B06] The pin generalises: the corner lane is asserted empty whenever `data-tug-sheet-presented` is set.** `at0530` re-asserts the notice's box inside the shade's box instead of between shade and editor, keeps Retry landing the commit the first press asked for, and its corner-lane check becomes the general tripwire. `tuglaws/modal-rest-line.md` loses the seam sentence at line 60 and says instead: a refusal of a shade gesture speaks in the shade; the corner lane carries nothing that a presented shade's gestures produce.

---

## Non-goals {#non-goals}

- **Keeping the seam strip for commit and join and adding a shade seat for the rest.** Two seats for one class of refusal, at two distances from the shade. Rejected under [B01].
- **Closing the lane while the shade is up and re-routing posts.** A guard on the provider would hold, but it keeps six controllers alive to be re-routed and makes the rule a runtime branch rather than an absence. [B02] removes the callers instead; the tripwire [B06] is the guard.
- **A modal dialog in the shade.** `TugAlert` would claim focus and break the shade's passivity ([P17]). The blocked join already shows the dialog vocabulary without the modality ([F04]); this uses that.
- **Changing what the notices say.** `landing-notice.ts` and the other controllers' texts are already right and already tested. Only the seat moves.
- **Touching the corner lane's remaining tenants.** Transient interruptions, attachment errors and the privacy refusal are not shade gestures and stay where they are.

---

## Exit {#exit}

**An arc.** First steps, in the order they have to land:

1. Add `SessionChangesNotice` under the shade header in `session-changes-view.tsx`, rendering `TugInlineDialog` from the landing mode's snapshot (via `landingNoticeFace`) and from the claim / discard / draft / arc-bind / arc-press / arc-replay stores — the same subscriptions the controllers hold today, read through `useSyncExternalStore` ([L02]).
2. Wire Retry to `LandingMode.retry()` and the shade-raise on a closed-shade refusal ([B05]).
3. Delete the six controllers and `SessionLandingNoticeStrip` with its CSS; drop their mounts from `session-card.tsx`.
4. Re-pin `at0530` to the shade's box and generalise its corner-lane assertion into the presented-shade tripwire; update `at0435`/`at0436` where they name the strip.
5. Rewrite the two sentences in `tuglaws/modal-rest-line.md` ([B06]) and note in `commit-failure-notice-brief.md` that its [B01]/[B02] are superseded here.
