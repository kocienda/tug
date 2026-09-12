<!-- brief-skeleton v1 -->

# Take the masthead's description band back, and show the post's lede

**Purpose:** The Session masthead reads as widely spaced with a hole under its last line. One number did it: the description's band went from 15.6px to 26px in `55f872476` so a commit pill would not be clipped, and that cost is charged to every card on every render, while the pill it was bought for appears in one rung the masthead shows a fraction of the time.

---

## Purpose {#purpose}

The user's words, on the masthead after the `narration-one` arc landed: "The masthead looks terrible like this. Widely-spaced lines, extra space. … It's true that the descriptions we get from the Overview function are now longer, and I want to show them in full (or close to it) if we can, but we can't allow it to unbalance the entire session masthead like this. If we can't find a solution, then I suggest that we *go back* to a different/shorter *voice* for the session masthead, that produces shorter descriptions that can fit on one line, which would then mean that we could go back to the two-line/shorter session masthead."

The screenshot shows a card at rest: the title `tug/steep-order`, the description "Land the audited `narration-one` arc, ready for the user to merge", the rest line "1 turn, 924 KB. Last updated: Sep 12, 6:34 PM. Ready.", and a band of empty tier under it.

This brief's position is that the voice did not break the masthead and a new voice would not fix it. The line in the screenshot is already the short voice, and it fits. What broke is a band, and the band comes back first; whether the second line is worth keeping is a question that can only be judged once it has.

---

## Evidence {#evidence}

**[F01] The line in the screenshot is the standing sentence, and it is already one line by contract.** The Observer writes two things (`tugrust/crates/tugcast/src/feeds/overview_agent.rs`): the post, "one or two sentences, 200 characters of prose at the outside", and the standing sentence, "one line under its name, saying what it is about", with "ROOM FOR ABOUT 65 CHARACTERS, and shorter is better", verb first, no paths, no tools. "Land the audited `narration-one` arc, ready for the user to merge" is 63 characters. **(verified)**

**[F02] One number did all of it.** `tugdeck/src/components/tugways/tug-session-row.css` sets the description's band to `--tugx-session-row-sub-line-tight` (`13px × 1.2 = 15.6px`), and `.tug-session-row[data-description-type="loose"]` raises it to `max(15.6px, --tugx-atom-line-box-floor)`. The floor is `atomLineBoxFloorPx()` in `tugdeck/src/lib/atom-register.ts`: the pill's 22px plus a 4px cushion, 26px. The masthead and the Cards rail declare `loose`. `tugdeck/src/components/tugways/masthead-frame.css` carries the consequence as `--tugx-session-masthead-extra-line: 30px`, up from 16, so the tier is 102 rather than 88; `SESSION_FOLDED_HEIGHT_PX` went 144 to 158, and `at0551`, `at0552` and `at0553` were re-pinned to those numbers. **(verified)**

**[F03] The air lands in two places, and both were fine at the old magnitude.** Inside the band a 13px sentence has 6.5px of half-leading each side instead of 1.3px, so the title, the description and the beat no longer read as one group. Under it, the description box is `flex: 0 0 auto` inside a `-webkit-line-clamp: 2` in `session-masthead.css`, so a one-line sentence hands its unused line back as slack at the foot of a fixed tier: 26px now, 15.6px before. The `session-tape-centering` arc decided that slack "reads as the edge of the tier". That was decided at 15.6px. **(verified by reading; the at-rest slack has not been measured on the built app)**

**[F04] The rung that pays is not the rung that benefits.** The Observer's post rubric says to spell a sha "exactly as the facts give it, in backticks", so shas live in the post. The standing sentence rubric bans paths and tools and gives 65 characters; a sha there is possible and unusual. The loose band exists for the post and is charged to every render of the sentence, which is what an idle card shows. **(verified)**

**[F05] The post does not fit at either band.** 200 characters of prose against roughly 140 of visible room on two lines. The loose band bought air, not fit; the second line was always going to end in an ellipsis on a full post. **(verified by arithmetic, not measured)**

**[F06] The digester already knows where a sentence ends.** `tugrust/crates/tugcast/src/feeds/session_digest.rs` carries `sentence_ends`, `ends_settled` and `freshest_sentence`, and the Observer is told to write complete sentences that end sooner as the budget nears. A post's first sentence is available without a new field or a second model call. **(verified)**

**[F07] A confirmed path on this line is already a mention.** `tug-atom-ref.tsx` states the two forms: an atom is a value somebody placed, a mention is characters somebody wrote, rendered as those characters plus a resting underline once a resolver confirms them. A path written in a description already renders that way, with the file bubble on hover. A sha written in the same sentence is a mention by the same definition, and `commit-tip-portals.tsx` is what turns it into a 22px pill. `TugAtomRef` has `file` and `arc` arms and no commit arm, and is for placed values only. **(verified)**

**[F08] The second-line arc left itself a revert for this complaint.** The join message of `fcc60dc88` ends: "One reading is left to take on the running app … whether the second line under a standing sentence, on an idle open card beside a folded wall, reads as air or as a hole. If it reads as a hole, that half is revertible whole and the folded swap stands alone." It predicted the reading at 15.6px of slack. **(verified)**

---

## Decisions {#decisions}

**[B01] The description's band goes back to tight on every mount, and the `loose`/`tight` split is retired.** The tier returns to 88, the folded card to 144, and the three re-pinned app-tests return with them. This is the whole of the visual complaint, and it is one number. What would revisit it: nothing short of the description's type scale changing.

**[B02] A confirmed sha in a description renders as a mention, not a pill.** The run keeps its characters and takes the resting underline and the commit hover, exactly as a confirmed path does on the same line ([F07]). The 2026-09-04 decision settled the pill across five reading surfaces at roughly 15px type in a 1.6 band; the description is chrome at 13px in a 1.2 band, and a 22px box in a 15.6px band is an arithmetic disagreement with that decision rather than a taste one. This is a surface rule, stated once for the description line, and it opens no second register: the pill's height and form are untouched everywhere the pill is drawn.

**[B03] The masthead shows the post's first sentence.** During a turn the description rung is the post's lede rather than the post ([F06]); the Overview keeps the whole post. A lede is around a hundred characters, fits two tight lines with room and often lands on one, and ends on a period rather than an ellipsis. Same text, same voice, no new field on the wire. This is what "in full, or close to it" means for a two-line box that cannot hold 200 characters ([F05]).

**[B04] The second line is judged after [B01] through [B03] land, and not before.** An idle card will then show a 63-character sentence in a 15.6px band with one tight line of slack under it, which is the geometry [F08]'s reading was predicted for. If it still reads as a hole, that arc's own revert is the answer: the post rung leaves the description ladder, the masthead returns to two lines at 72, the folded card to its two-line height. That is a real option and a cheap one, and it is not spent to fix a `max()`.

**[B05] The at-rest slack is measured before [B04] is judged.** The tier arithmetic in this brief is quoted from `masthead-frame.css`'s own comment rather than measured ([F03]); the judgment in [B04] is worth making only against a number read off the built app, open and folded.

---

## Non-goals {#non-goals}

- **A new, shorter Observer voice for the masthead.** There is one, it is the standing sentence, and it is the line in the screenshot ([F01]).
- **A third field from the Observer.** One more thing to get right every sixty seconds and a third rung to keep consistent with two. [B03] gets the same result from text that already exists.
- **A second atom register for chrome rows.** `atom-register.ts` retired per-site sizes on 2026-09-04 and `at0513` pins five surfaces to one number. [B02] changes which form a mention takes on one surface, not how big a pill is.
- **A commit arm on `TugAtomRef`.** The ref skin is for placed values; a sha in prose is written, and the docblock is explicit that the difference is structural and never a judgment call ([F07]).
- **Padding the description box once instead of every line.** Considered as the way to keep the pill: `padding-block` of about 5.2px, so the tier pays 10.4px rather than 20.8px. Rejected because a pill on the first of two lines still overhangs into the second line's ascenders; it fixes the clip and not the collision, and it still moves the tier.
- **Retiring the post rung now.** That is [B04]'s fallback, taken only if the second line reads as a hole at the geometry it was designed for.

---

## Exit {#exit}

An arc. The shape it starts from:

1. The band back to tight and the split retired ([B01]), with the tier, the folded height and `at0551`, `at0552`, `at0553` returned to their prior numbers.
2. The description's commit mention rule ([B02]), with `at0561`'s pill assertion rewritten to assert the underline and the hover on the run instead.
3. The lede on the masthead ([B03]) in `session_digest.rs` or at the deck's description ladder, whichever the door finds already owns the split, with a unit test on a two-sentence post.
4. Measure the at-rest slack open and folded ([B05]) and record it; the reading in [B04] is the user's.

1 and 3 are independent. 2 depends on 1. 4 follows all three.
