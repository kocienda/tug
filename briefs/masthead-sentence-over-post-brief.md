<!-- brief-skeleton v1 -->

# Put the session's standing sentence back on top, the post under it, and take the beat off the masthead

**Purpose:** During a turn the Session masthead replaces the one line that says what a session is for with a line that says what it just did, and gives the fold's extra line to that news. The line under both is a tool beat too low-level to tell one session from another or to say whether a session is on track. The masthead should read, top to bottom, as identity, then account; the beat has no seat on it.

---

## Purpose {#purpose}

The user's words, on the masthead after the `masthead-band-and-lede` arcs landed:

> I still am not satisfied with the way that the three-line masthead lede/pulse/beat is working. I kind of miss the older top line we used to have, that would give me more of an overview about *what the session was doing at a higher level*. Now, we get the Overview-like summary of the lower-level work just done, and a more down-in-the-weeds line which is really never actually helpful to me since *it sits at too low a level* to help me distinguish a session from others or give me any sense of whether this session is on track or not.
>
> Look... this is a *masthead*. I think we should bring back the summary line, make it *one line* and put it on top. Then use the Overview-like description and put that on the two lines below.

Two forms were shown as already right and not to be disturbed: a brand-new session reading `tug/edgy-board` / `Created Sep 12, 11:45 PM` / `No turns. Ready.`, and a resumed session at rest reading `session-minimize` / `Implement session minimize reveal from the brief work` / `1 turn, 1.1 MB. Last updated: Sep 12, 11:42 PM. Ready.`

The sketch that settled the shape is in the conversation. Its one open question, whether the two account lines carry the post whole or its first sentence, was put to the user and answered: **the whole post, ellipsized**. The at-rest form was confirmed as the rest sentence. Both are recorded under Decisions.

---

## Evidence {#evidence}

**[F01] The line the user misses is the standing sentence, and it never went away.** The Observer writes it on every wake, in the same envelope as the post ([D187]); `observer.rs` writes it to the session's synopsis field through `write_synopsis`, and a null or empty field leaves the prior sentence standing. It is what both screenshots show at rest. **(verified)**

**[F02] What retired it during a turn is the [D187] override in the description ladder.** `session-identity-row.tsx` at the `livePost` / `liveAsk` block sets the description to the post's lede when a turn is in flight and a post exists, else the turn's ask, else the rest description. The rest description is the [D132] ladder: standing sentence, first prompt, arc purpose, created stamp, undescribed. Before `d91d2fddb` the ladder had no turn override: the sentence stayed up through a turn and the pulse's intent and beat ran under it. That is the "older top line". **(verified, by reading the current file and the diff of `d91d2fddb`)**

**[F03] The standing sentence's rubric is a news rubric.** `OBSERVER_POST_INSTRUCTIONS` in `overview_agent.rs` says the sentence is "weighted toward what it is about NOW" and "the newest ask is the subject; earlier work earns a place only if the line has room after it." That tilts the identity line toward the latest thing, which is the post's job. **(verified)**

**[F04] The Observer rewrites the sentence blind.** `compose_observer_input` in `observer_wake.rs` carries the wake reason, the last five posts, the settled facts, and the digest window. It does not carry the sentence currently standing. The synopsis job it replaced did hand the model the previous sentence (`compose_synopsis_digest`, per the consolidation brief's [F08]). Nothing now asks the model to keep a good sentence; it composes a fresh one every sixty seconds. **(verified)**

**[F05] The beat is the shortest and fastest thing on the tier.** It is the digest's newest line, of the "Editing foo.ts, 37 lines" kind, broadcast under `VOICE_THROTTLE_MS` at about one per second ([D186]). The second-line brief's [F04] made this the argument for not giving the beat the fold's extra line; the user's report makes it the argument for not giving the beat the masthead at all. The beat keeps its other readers: the `DIGEST` feed, the Observer's window, the Activity card, the Cards rail, and the beat-history popover the masthead's activity line opens. **(verified for the readers; `rg` over the deck)**

**[F06] The two-line box already exists on the masthead, on the description run.** `session-masthead.css` clamps `.tug-session-row-description` to two lines in every form, and the tier's second line is `--tugx-session-masthead-extra-line` in `masthead-frame.css`, declared on the pane whatever the box measures. `at0564` measures the at-rest slack under a one-line description. Moving the two-line box from the description run to the activity run changes which run wraps and nothing about the tier. **(verified by reading; not yet measured after the move)**

**[F07] The lede rule cuts a two-sentence post to its first sentence.** `postLede` in `session-identity-row.tsx` returns the first sentence when it ends inside `LEDE_BUDGET_CHARS` (140), else the whole post. The Overview shows the whole post. So the masthead and the Overview differ on any two-sentence post whose first sentence is short. **(verified)**

**[F08] The Cards rail renders the same row.** `CardsSessionRow` mounts `SessionIdentityRow` with a one-line description and a one-line activity. Whatever the masthead's ladders say, the rail says in one line each. **(verified)**

**[F09] Nine app-tests pin the current form.** `at0498` (the beat's file reference opens on the line and in its popover), `at0551`, `at0553`, `at0557` (fold form, wall, shapes), `at0559`, `at0560` (ready folded and open forms), `at0561-narration-annotation`, `at0564` (at-rest slack), `at0565` (the beat skips results). **(verified, by file header)**

---

## Decisions {#decisions}

**[B01] The masthead's second run is the standing sentence, one line, in every form, with no turn override.** The description ladder returns to [D132] exactly: standing sentence, else first prompt, else arc purpose, else created stamp, else undescribed. The [D187] override in [F02] is removed from this run. This is the line a wall is scanned by and the line that tells one session from another; a line that changes because a turn started cannot do either job. What would revisit it: the Observer ceasing to write a standing sentence at all.

**[B02] The masthead's third run is the account, two lines: the whole post during a turn, the rest sentence at rest.** The ladder is [D187]'s, moved down one run: the compaction pin, else the newest post while a turn is in flight, else the turn's ask while a turn is in flight and no post has landed, else the rest sentence. The two-line clamp and the wall register move from the description run to this one ([F06]). The at-rest form is unchanged, which is why both screenshots in Purpose come out the same.

**[B03] The post is shown whole and ellipsized, and the lede rule is retired.** The user's call, made against the alternative of the first sentence. The masthead's two lines and the Overview's post are now the same text whenever the post fits, and a post that does not fit is cut with the same mark a one-line description already uses. `postLede`, `LEDE_BUDGET_CHARS`, `firstSentenceEnd`, and their unit tests go. This reverses [B03] of `briefs/masthead-band-and-lede-brief.md`; where the two disagree, this one stands. What was given up: a post always ending on a period on the masthead. What was bought: one representation, which the user asked for in so many words on the `narration-one` brief.

**[B04] The beat leaves the masthead.** It is [F05]'s line, and it is the line the user says is never helpful at this altitude. The `DIGEST` feed, the digester, the Activity card, and the rail's beat are untouched; only the masthead's activity run stops reading it. The beat-history popover stays openable from the account run, so the digest tail is one click away rather than zero, and `at0498`'s file-open claims re-point to the popover. What would revisit it: a folded wall that reads as dead without it, which is [B08]'s reading.

**[B05] The Observer is shown the sentence it is revising, and told to return null unless the subject has moved.** `compose_observer_input` gains a `STANDING SENTENCE NOW:` section ([F04]). The instructions say: keep it when the session is still about the same thing, and null already means "leave it as it stands" ([D187]). Stability becomes the default of the identity line rather than a coincidence of five consecutive rewrites landing on similar words.

**[B06] The sentence's rubric is rewritten from "NOW" to the through-line.** [F03]'s "weighted toward what it is about NOW" and "the newest ask is the subject" become: what this session is FOR across its run, named so a reader can tell it from the sessions beside it. The post owns whether the session is on track; the sentence owns which session this is. Verb-first, one subject and one object, about 65 characters, sentence case: those rules stand.

**[B07] The Cards rail follows the masthead's ladders, one line each.** Sentence on top, post under it during a turn, rest sentence at rest ([F08]). That is a gain for scanning a list of sessions, which is the rail's job, and it is read on the running app rather than assumed.

**[B08] [D187] and [D185] are amended, and [F09]'s tests follow.** [D187]'s "the masthead's upper line is the post" becomes "the masthead's account run is the post"; [D185]'s two-line run is the account run. The second-line brief's [B03], which declined a stable line over the post, is reversed with this brief as the reason. The tests are re-pointed as the doctrine's own pins moving with the doctrine, not another decision's pin rewritten to fit.

**[B09] One reading is taken on the running app before the beat's retirement is kept: a folded wall mid-turn.** The phase dot and the sparkline carry "working", and the post refreshes once a minute. If the wall reads as dead without the beat, the answer is not a fourth run; it is the beat on the account run's hover, and that is the only place it may return.

---

## Non-goals {#non-goals}

- **A fourth run on the masthead.** The tier is three runs and one two-line box. The beat is not squeezed under the account as a fourth line, and the sentence is not given a second line.
- **A tier whose height follows the turn or the fold.** [D185] holds; the box moves, the tier does not.
- **The lede as a compromise.** Considered and put to the user; rejected in favour of the whole post ([B03]). Not to be re-proposed as "just for long posts".
- **Tightening the Observer's 200-character post budget to fit two lines.** Offered as the way to make the lines identical always; not taken. The channel keeps its second sentence, and the masthead ellipsizes.
- **Showing the newest post at rest.** Confirmed by the user as the rest sentence. The Overview holds the last post; the masthead at rest says the session is idle and since when.
- **A third field from the Observer.** [B05] and [B06] change what the model is shown and asked; the envelope stays two fields.
- **Changing the beat, the digester, or the `DIGEST` feed.** [D186] is untouched. The beat loses one reader.
- **Touching the picker and gallery cells.** They render the description ladder with no beats and are unaffected.

---

## Exit {#exit}

An arc. The shape it starts from:

1. The two ladders in `session-identity-row.tsx` ([B01], [B02]): the turn override leaves the description run and lands on the activity run; the beat read is dropped from the masthead's activity ladder ([B04]); `postLede` and its helpers are deleted ([B03]). The two-line clamp and the wall register move to the activity run in `session-masthead.css` and `tug-session-row.css` ([F06]).
2. The beat-history popover kept openable from the account run, with `at0498` re-pointed at it ([B04]).
3. The Observer's input and rubric in `observer_wake.rs` and `overview_agent.rs` ([B05], [B06]), with a unit test that a wake carrying the standing sentence and a null field leaves it standing, and an `overview-replay` read of a real transcript to see that the sentence now holds across a turn.
4. [D185] and [D187] amended; `at0551`, `at0553`, `at0557`, `at0559`, `at0560`, `at0561`, `at0564`, `at0565` re-pointed ([B08]); the at-rest slack re-measured after the box moves.
5. The readings on the running app: an open card mid-turn, a folded wall mid-turn ([B09]), and the Cards rail ([B07]).

1 and 3 are independent. 2 depends on 1. 4 follows 1. 5 closes.
