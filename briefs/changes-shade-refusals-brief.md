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

**[F02] The capability was not removed; one caller was.** The corner lane — `TugPaneBulletinProvider placement="top-right"` at `session-card.tsx:4640` — is fully live, still sits in the transcript region the shade's scrim covers, and six zero-render controllers still post into it: `claim-error-notice-controller.tsx`, `discard-error-notice-controller.tsx`, `arc-press-notice-controller.tsx`, `arc-replay-notice-controller.tsx`, `draft-error-notice-controller.tsx`, `arc-bind-error-notice-controller.tsx`. Every one of them lands exactly where the screenshot's commit failure did. **(verified** — grep of `TugPaneBulletinProvider` mount sites and the controllers' headers.)

**[F08] Only some of those six are shade gestures, and the controllers cannot tell which press they are reporting.** A notice is keyed on a store, and the store does not record where the press came from. Sorting them by origin: **Claim / Disclaim** is a file row inside the shade; **Discard** and **Replay** are the shade's arc-row menu (`arc-row-menu.tsx` offers exactly those two) — but also reachable from the Arcs card's row. **Start / Resume / Stop** does *not* appear in the shade at all: `ArcTransportControl` mounts in `arcs-card.tsx`, `arc-lifecycle-block.tsx` (a transcript block) and `session-card-telemetry-popovers.tsx`, and `arcPressStore.press` is also called by the transcript's `session-arc-receipt-block.tsx` Resume button. **`/arc <name>`** (`arcBindErrorStore`, fed from `action-dispatch.ts`) is typed into the composer with the shade in any state. **Auto-Message** is a composer button, usually but not necessarily shade-up. So a rule that moves a *controller* moves notices belonging to presses made on three other surfaces. **(verified** — grep of `arcPressStore` / `arcReplayOutcomeStore` / `arcBindErrorStore` callers and `ArcTransportControl` mount sites.)

**[F09] `arc-replay-notice-controller.tsx` speaks for successes too.** `replayed`, `recorded` and `current` post in the plain tone; only `deferred`, `conflicted` and `error` are cautions. A seat built for refusals has to say what becomes of the other three, since they are behind the same scrim when the shade is up. **(verified** — read the file.)

**[F10] The shade's shell is a header div and a body div, and the band has no seat yet.** `session-changes-view.tsx`'s `shell()` renders `.tug-sheet-shade-header` followed by `.session-changes-view` wrapping `.session-changes-view-body`; nothing between them is fixed against the scroller. A band that does not scroll with the rows needs one of those elements to gain a non-scrolling first child, which is a structural change to the shell rather than an insertion into the body. **(verified** — read the file.)

**[F03] The seam strip is not in the shade.** `SessionLandingNoticeStrip` sits in `.session-card-entry-pane`, below the shade. `briefs/commit-failure-notice-brief.md` [B02] rejected "inside the shade" on the ground that a notice there "would scroll with the file list and sit under the rows rather than over the button" — an argument about a *scrolling* seat, which a fixed band under the header does not have. **(verified** — the strip's docstring and the prior brief.)

**[F04] The shade already hosts a refusal as a dialog: the blocked join.** `session-changes-arc-join.tsx` renders each join blocker as a `TugInlineDialog` — icon, title, remedy sentence, one Resolve action — the same primitive `PermissionDialog` and `QuestionDialog` are built on, because "a refusal with one act to clear it *is* a dialog and Tug has that vocabulary already" (its own docstring). It takes no key view; the shade stays passive ([P17]) and the composer keeps focus. **(verified** — read the file.)

**[F05] The words already exist and are pure.** `landing-notice.ts` — `COMMIT_CAUSES` (lock held, identity unset, hook refused, nothing to commit, hunk drift, already staged) and `describeLandingFailure` — decides title, remedy, and folded detail from git's stderr with no knowledge of where it renders, and is pinned by `landing-notice.test.ts` against real stderr. `LandingMode.retry()` exists on both mode controllers as `land()` over the live message, and the land button already reads "Retry commit" while a refusal stands. **(verified.)**

**[F06] The doctrine names the seam, not the shade.** `tuglaws/modal-rest-line.md:60` says a refusal of the Changes gesture "speaks on it — `SessionLandingNoticeStrip`, in the entry region under the shade's bottom edge"; line 78 says the corner lane "carries nothing landing-shaped." The second sentence is a rule about one shape of notice, enforced by prose only — [F02] is six standing violations of its spirit. **(verified.)**

**[F07] `at0530` pins the seam geometry.** `tests/app-test/at0530-commit-failure-speaks-at-the-seam.test.ts` asserts the strip's box sits between the shade's and the editor's, and that the corner lane is empty of anything commit-shaped. Moving the seat means re-pinning the first assertion; the second is the tripwire this work generalises. **(verified.)**

---

## Decisions {#decisions}

**[B01] Every refusal of a gesture that starts in the Changes shade speaks inside the Changes shade.** The shade is the commit surface ([D117]); a refusal of something done on it belongs on it, in the user's line of sight, not in a lane the shade's scrim dims and not in a seam below it. This supersedes `commit-failure-notice-brief.md` [B01]/[B02]: the seam was a half-measure that fixed one caller's seat and left the lane open to the rest ([F02]). It rules out any z-index or opacity fix that would keep the corner lane in play, and it rules out keeping the seam strip for commit and join alongside a shade seat for the others — one seat, or the same distance mistake at two distances.

**[B02] The corner-lane route is removed, not avoided — but the unit of removal is the *gesture*, not the controller.** "Not ever" is a fact only when there is no code to do it, so the end state is that no press made on the shade can reach the corner lane and no future `api.danger()` from a shade verb has a precedent to copy. [F08] is why this cannot be six deletions: three of those stores are also fed by presses made on the Arcs card, a transcript block and a popover, and deleting their controllers would silence notices that were never behind the scrim. The removal has to be cut along origin — which is the open question below. What is settled: `SessionLandingNoticeStrip` and the claim/disclaim and discard controllers go (their presses exist only in the shade), the pane-bulletin provider itself stays for its non-shade tenants (`TransientNoticeController`, the attachment-error caution, the privacy refusal), and a tripwire ([B06]) makes the lane's emptiness under a presented shade a tested fact rather than a docstring's promise.

**[B03] The seat is one `SessionChangesNotice` band, fixed under the shade's header and above its scroller.** Fixed is what answers the prior brief's objection ([F03]): it does not scroll with the rows, it is visible wherever the list is, and it is one place for every refusal the shade can produce. The header's own cluster (labels, fold-all, pop-out, X) is untouched; the band is the body's first child and renders nothing when there is nothing to say, the same self-hiding the strip had.

**[B04] The face is `TugInlineDialog`, exactly as the blocked join renders it ([F04]).** Tone icon, title in the user's frame, remedy sentence, git's verbatim detail folded and copyable, and the one act the refusal admits — **Retry** for a server-refused commit or join (`LandingMode.retry()`, [F05]), **Dismiss** for everything else. Not a bulletin, not `TugAlert`: it takes no key view, so the shade stays passive ([P17]) and the composer keeps focus. Claim, disclaim, discard, draft, arc-press, arc-replay and arc-bind refusals seat in the same band with their own title and detail and no Retry; their stores and subscriptions are unchanged — the words move, the plumbing does not.

**[B05] A commit or join refused while the shade is closed raises the shade to say so.** The shade is where the refusal speaks ([B01]); a refusal with nowhere to appear is the silent-dead-button failure the arc verbs have already paid for once ([L31]). Opening the shade is what the commit itself would have shown the user had it landed, so it is not a surface moving on its own. A gate refusal the deck makes before sending (`landRefusal`) keeps its current behaviour of standing briefly and fading, from the band.

**[B06] The pin generalises: the corner lane is asserted empty whenever `data-tug-sheet-presented` is set.** `at0530` re-asserts the notice's box inside the shade's box instead of between shade and editor, keeps Retry landing the commit the first press asked for, and its corner-lane check becomes the general tripwire. `tuglaws/modal-rest-line.md` loses the seam sentence at line 60 and says instead: a refusal of a shade gesture speaks in the shade; the corner lane carries nothing that a presented shade's gestures produce.

---

## Open Questions {#open-questions}

- **How is a notice's origin decided, given that its store does not carry one ([F08])?** Three readings, and they produce different code: (a) the *press site* stamps an origin when it calls the store, and the band shows only shade-origin notices; (b) the band shows every notice while the shade is presented and the corner lane shows them while it is not, keyed on presented state alone, so origin is never recorded; (c) the affected stores are split, so a shade press and an Arcs-card press are different notices by construction. This decides what gets written in `arc-press-store.ts`, `arc-replay-outcome-store.ts`, `arc-bind-error-store.ts` and every one of their call sites, so it cannot be deferred to whoever writes the code.
- **What becomes of the replay successes and the `/arc` bind refusals ([F09])?** A `replayed` / `recorded` / `current` line is not a refusal and has no act; a bind refusal is a refusal of something typed in the composer. Both are behind the scrim when the shade is up, which argues they move; neither fits the dialog-with-one-act face [B04] describes, which argues the band needs a second, actless register — or that they stay in the lane and the tripwire [B06] is narrowed to refusals.
- **Where exactly does the band seat in the shell ([F10]), and does it push the shade's `shadeAutoSize` geometry?** The prior arc's [B02] read a notice inside the shade as one that would scroll with the rows; a fixed band answers that only if it sits outside the scroller, which the current two-div shell has no slot for.

---

## Non-goals {#non-goals}

- **Keeping the seam strip for commit and join and adding a shade seat for the rest.** Two seats for one class of refusal, at two distances from the shade. Rejected under [B01].
- **Closing the lane while the shade is up and re-routing posts.** A guard on the provider would hold, but it keeps six controllers alive to be re-routed and makes the rule a runtime branch rather than an absence. [B02] removes the callers instead; the tripwire [B06] is the guard.
- **A modal dialog in the shade.** `TugAlert` would claim focus and break the shade's passivity ([P17]). The blocked join already shows the dialog vocabulary without the modality ([F04]); this uses that.
- **Changing what the notices say.** `landing-notice.ts` and the other controllers' texts are already right and already tested. Only the seat moves.
- **Touching the corner lane's remaining tenants.** Transient interruptions, attachment errors and the privacy refusal are not shade gestures and stay where they are.

---

## Exit {#exit}

**An arc.** The shape of the work, with the ordering it is known to have:

- The band's seat in the shell and the origin rule are the two things everything else waits on — the first open question decides what gets written in three stores and all of their call sites, and the third decides whether the shell changes structurally. Neither can be settled by whoever writes the code.
- Once they are: `SessionChangesNotice` under the shade header, rendering `TugInlineDialog` from the landing mode's snapshot (via `landingNoticeFace`) and from whichever of the claim / discard / draft / arc-bind / arc-press / arc-replay stores the origin rule routes there, read through `useSyncExternalStore` ([L02]); Retry wired to `LandingMode.retry()`; the shade-raise on a closed-shade refusal ([B05]).
- Then the deletions, which cannot precede the seat: `SessionLandingNoticeStrip` with its CSS, the controllers the origin rule empties, and their mounts in `session-card.tsx`.
- Then the pins: `at0530` re-anchored to the shade's box, its corner-lane assertion generalised into the presented-shade tripwire, `at0435` / `at0436` updated where they name the strip.
- Last, the doctrine: the two sentences in `tuglaws/modal-rest-line.md` ([B06]), and a note in `commit-failure-notice-brief.md` that its [B01]/[B02] are superseded here.
