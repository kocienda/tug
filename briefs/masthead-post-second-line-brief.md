# The masthead's second line belongs to the Observer's post, not the beat

**Purpose:** A folded Session card gives its masthead one extra line, and that line goes to the beat, which is the shortest thing on the tier. The Observer's post above it, the longest and most on-point thing on the tier, is cut to a third. This brief moves the line, and stages the question of whether every Session card should carry it.

---

## Purpose {#purpose}

The user's report, verbatim:

> Really feels to me that the top-line pulse/beat *is the one that should be getting the second line of content when we fold*. In fact, it might even be better to show this second line (and therefore a three-line masthead for pulse/beat) *all the time*, since the content the Overview shows is a little more voluminous, *but actually on point*. Think about this. Any reason *not* to do this?

Two things are asked: which run on the masthead should take the fold's extra line, and whether the extra line should be there on an open card too. The sketch that settled both is in the conversation; the user took its recommendations, and they are recorded under Decisions.

Vocabulary, so the rest reads unambiguously. The Session card's masthead is a fixed 72px tier carrying three runs: the **title** line (identity), the **description** line (the Observer's newest post during a turn, else the turn's ask, else the standing sentence), and the **beat** line (the digest's newest line, [D186]). The "top-line pulse/beat" of the report is the description line while it carries a post. Folded, the tier is 88px and the beat wraps to two lines ([D185]).

---

## Evidence {#evidence}

**[F01] The fold's extra line goes to the beat.** `tugdeck/src/components/tugways/session-masthead.css` clamps `.tug-activity-line-activity` to two lines under `.tug-pane[data-folded="true"]`, with a fixed `min-height` of two lines; the description and title keep their single-line ellipsis, by a comment that says only the beat wraps. The tier's growth is `--tugx-masthead-beat-extra-line` (16px) in `masthead-frame.css`, added to `--tug-masthead-height` in `tug-pane.css` only when `data-folded` is set; `MASTHEAD_FOLDED_HEIGHT` in `tug-pane.tsx` mirrors the sum. `session-identity-row.tsx`'s `activityRegister="wall"` wraps the beat run in a `data-register="wall"` span that the CSS keys on. **(verified, read from the code)**

**[F02] The description line during a turn is a 200-character post in a one-line slot.** The Observer's instructions in `tugrust/crates/tugcast/src/feeds/overview_agent.rs` budget a post at "one or two sentences, 200 characters of prose at the outside", every sentence complete within the budget, and `clamp_post_body` cuts a long one on a sentence boundary. `session-identity-row.tsx` puts `livePost.body` on the description line whenever a turn is in flight and a post exists. A masthead line at a typical card width holds roughly 65 to 75 characters, so the post is ellipsized on nearly every card that shows one, and on a folded card nothing beneath it carries the rest. **(verified for the budget and the ladder; the characters-per-line figure is an estimate from the xs type size, not a measurement)**

**[F03] The standing sentence fits one line by contract.** The same instructions give the standing sentence "room for about 65 characters, and shorter is better", and it is what the description line shows at rest. A second line under it would be empty on a resting card most of the time. **(verified)**

**[F04] The beat is short and fast; the post is long and slow.** The beat is a digest line of the "Editing foo.ts, 37 lines" kind, usually one line with room to spare, broadcast under `VOICE_THROTTLE_MS` at about one per second. The post refreshes on the Observer's wakes, whose dominant cadence is `DEFAULT_SITREP_SECS` = 60 ([D187]). A two-line wrap box holding the beat flickers between one and two lines of ink at the beat's rate; the same box holding the post changes once a minute. **(verified for the cadences; the flicker is an inference from them, confirmable on the running app)**

**[F05] The post is worth most exactly where the fold is.** [D103] retired the model commentator because it restated a transcript the reader was already following. [D185]'s wall is the surface with no transcript, and [D187] already made the post the masthead's upper line and brought the sitrep down to 60 s because "a line a reader watches should not be slower than the line it stands in for". The fold is where the post carries the whole account of the session, and it is where the post is cut shortest. **(inference from the three decisions)**

**[F06] The fold form is pinned by its own tests.** `tests/app-test/at0551-session-fold-form.test.ts` measures the 88px tier as 72 + 16 and reads which run clamps; `at0552` (height), `at0553` (wall), and `at0557` (shapes) exercise the same form. They are [D185]'s pins, not a neighbouring decision's. **(verified, by file header)**

**[F07] Two lines hold most but not all of a post.** At the estimate in [F02], two lines hold about 140 of the 200-character budget, so a long post still clips at narrow card widths, on a period thanks to the sentence-boundary clamp. The Overview card shows the whole post regardless. **(estimate)**

---

## Decisions {#decisions}

**[B01] Folded, the fold's extra line goes to the description run, and the beat returns to the one-line register.** The tier stays 88px; nothing about the fold's height, the wall's stability, or the Z2 row changes. The two-line clamp and its fixed two-line `min-height` move from the beat run to the description run, and the wall register's `data-register` wrapper moves with it so the CSS keys on the same attribute in the new place. The beat reads in the `"line"` register everywhere, which retires the last thing that made a folded masthead's beat different from an open one's. The argument is [F02] and [F04]: the extra line is spent on the longest and slowest content rather than the shortest and fastest. The title stays single-line, so the callsign a wall is scanned by never moves.

**[B02] This is the one written line finishing its sentence, not a second headline.** [D132] retired the per-stretch headline chain and the narration brief's non-goals say not to rebuild it. Giving the description run a second line adds no content and no producer; it lets a line that already stands there wrap. An arc reading this must not add a second run, a second ladder, or a second feed to fill the room.

**[B03] The description ladder is unchanged: the post during a turn, the ask before the first post, the standing sentence at rest.** Considered and declined: showing the newest post at rest, so the two lines carry "what did that one just do". The Observer's own contract separates news from identity, and the standing sentence is the identity a wall reader picks a session by. A light second line at rest ([F03]) is accepted. Whether the newest post at rest reads better on a wall is worth one look on the running app, and if it does that is a revision to this decision, not a quiet change. **Reversed 2026-09-13 by `briefs/masthead-sentence-over-post-brief.md` ([B01], [B02], [B08] there): the description run is the standing sentence in every form with no turn override, and the post reads on the account run under it, where the beat used to.**

**[B04] "Always" is a second, separate step, tried on the running app before it is settled.** The reasons not to do it outright are [F03] (a blank second line on every idle open card), the permanent 16px taken from every open transcript, and [D103]'s lesson that a post is least valuable with the transcript beneath it. None is fatal and none is an argument that a reading cannot end. So the first step lands the fold swap, and the second step makes the Session card's tier 88px in every form, keyed on the card rather than on `data-folded`, and is vetted with an idle wall beside an open card. The choice is binary: a tier whose height followed the turn state would ripple, which [D185] forbids. If the reading goes against it, the second step is dropped and [B01] stands alone.

**[B05] The Observer's post budget stays at 200 characters.** [F07] is noted, not acted on. The masthead is a glance and the Overview card shows the whole post; tightening the budget toward the masthead's slot would cost the channel the sentences it was given the budget for. Revisit only if the two-line masthead still reads as routinely cut off.

**[B06] [D185] is amended, and its tests are re-pointed as part of that amendment.** The decision's own text says "a two-line beat on a masthead one line taller"; it becomes a two-line description run, and [F06]'s tests follow the doctrine. This is [D185] revising its own form, which is the legitimate case; it is not another decision's pin being rewritten to fit a change.

---

## Open Questions {#open-questions}

- **What the second step looks like on an idle wall.** [B04] commits to trying it, not to shipping it. What settles it is the reading itself: an open Session card at rest beside a folded wall, on both a dark and a light theme, to see whether the blank second line under a standing sentence reads as air or as a hole.

---

## Non-goals {#non-goals}

- **A tier whose height follows the turn state.** Two lines during a turn and one at rest would move every card in the pane on every turn boundary. [D185]'s fixed-in-both-directions rule holds.
- **A second run on the masthead.** [B02]. The room is for the existing line to wrap.
- **Changing the Observer's cadence, budget, or envelope.** [D187] settled all three, and [B05] leaves the budget where it is.
- **Touching the Cards rows or the picker rows.** They read the `"line"` register, one line each, and are unaffected by where the fold's extra line goes.
- **Changing the beat, the digester, or the `DIGEST` feed.** [D186] is untouched. The beat only loses a wrap it never had room to use.

---

## Exit {#exit}

**An arc**, in two steps that must stay in order.

The first step is [B01] and [B06]: the clamp, the `min-height`, and the `data-register` wrapper move from the beat run to the description run; the wall register's docblock in `session-identity-row.tsx` and the fold comments in `session-masthead.css` and `tug-pane.css` say the description run wraps and the beat does not; [D185] is amended; `at0551`, `at0553`, and `at0557` read the new form. The check is the running app: a folded card mid-turn shows a post over two lines with a one-line beat under it, and the tier measures 88.

The second step is [B04]: the 16px term is applied to the Session card's masthead in every form, `MASTHEAD_FOLDED_HEIGHT` and its CSS twin are renamed for what they now are, `at0552` reads the new height, and the result is read on an idle wall beside an open card before it is kept. If it is not kept, the step is reverted whole and the brief's [B04] records the reading.
