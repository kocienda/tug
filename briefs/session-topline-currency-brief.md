# The session topline answers a new ask at once

**Purpose:** When the user submits a new message, the line under the session's name — on the masthead and on the Cards rail — keeps saying what the previous work was for, for a minute or more. The Observer must be woken by the submission, and must have a line it is allowed to rewrite when it wakes.

---

## Purpose {#purpose}

The user's report, verbatim: "When I submit a new message, the pulse topline should respond more quickly than it does now. This took quite some time to roll over, and it shouldn't."

The two screenshots that came with it are one moment. The Cards rail row for `tug/witty-steam` reads `Land the tripwires-phase-6 arc after a clean audit` on its top line, and under it a post that already names `briefs/tripwires-phase-7-brief.md` — the very thing the new ask asked for. The masthead's telemetry row says `Working`, `1m 17s`. The composer holds the ask: "Using `briefs/tripwires-multi-phase-brief.md`, write me a brief to achieve Phase 7 — A second tripwire and hardening".

The user's own diagnosis, on reading a first draft of this brief: "how about we trigger the Observer when a new request comes in from the user?" That is the solve, and this brief is written around it. What the trigger needs to be a solve is a field it is permitted to write when it fires — which the evidence below shows it does not have today.

---

## Evidence {#evidence}

**[F01] The topline is the ledger's `synopsis`, written only by the Observer.** `sessionDescription` (`tugdeck/src/components/tugways/session-identity-row.tsx`) is the description ladder: synopsis, else the first prompt, else the arc's purpose, else `Created …`, else `Not yet described`. The synopsis reaches the deck from `sessions.synopsis` via `list_sessions_ok` rows and `session_updated` pushes into `session-synopsis-store.ts`; `observer.rs`'s `write_synopsis` is its only writer, on the `synopsis` field of the Observer's envelope. Nothing on the deck writes it and nothing else on the wire does. **(verified)**

**[F02] In the reported failure the Observer had already woken, and declined to move the sentence.** The post on the account run describes the *current* turn — it names the brief the new ask asked for — and the elapsed clock reads `1m 17s`, past the 60-second sitrep. So a wake fired during the turn, read the new ask, wrote a post about it, and returned null for the sentence. **This is the finding that orders the work:** a submission trigger on its own would have arrived at that same null sooner. **(verified from the screenshots against the cadence in [F04]; that the model returned null rather than a rejected value is inferred, and `overview_replay` over this transcript would confirm it.)**

**[F03] The Observer is told to hold the sentence through a turn.** `OBSERVER_POST_INSTRUCTIONS` (`overview_agent.rs`): "If the session is still about the same thing, answer null for the sentence — null means 'leave it as it stands', and a sentence that holds through a turn is the line doing its job. Rewrite it only when the session's subject has moved." And: "a session that has spent an hour on one thing and a minute on a question is still about the one thing." A tripwires session asked for another tripwires brief has not moved its subject by that rule. The model was following its instructions. **(verified)**

**[F04] Nothing wakes the Observer on a submission.** `handle_submission_frame` (`observer.rs`) pushes the prompt's digest line into the session's window and returns. `push` arms `armed_at` only when the buffer was empty, and the loop's one timer is `armed_at + sitrep_secs`, sixty seconds (`DEFAULT_SITREP_SECS`, `overview_agent.rs`). `WakeReason` has four members — `TurnEnd`, `SitrepTimer`, `SessionEnd`, `TokenThreshold` — and no submission reason; `observer_wake.rs` says so on purpose: "the user asked something and nothing happened yet" is not post-worthy. **(verified)**

**[F05] The sentence's job was rewritten from currency to identity two days ago, in the opposite direction from this report.** `briefs/masthead-sentence-over-post-brief.md` (2026-09-13): [B01] removed [D187]'s live-turn override from the description ladder, because "a line that changed because a turn started" could neither be scanned nor tell one session from another; [B06] rewrote the rubric from "weighted toward what it is about NOW" to the through-line. [D187]'s amendment records the result: on a thirteen-wake replay the sentence "held on six and moved on seven, each move following a change of subject." **(verified)**

**[F06] The original complaint that made the synopsis was staleness.** [D132] (`tuglaws/design-decisions.md`): "A first prompt describes where a session *started*; a description has to be current, which is the whole complaint." So the one string has been asked to be current ([D132]), then to be stable ([F05]), and is now reported stale again. Two readers want opposite cadences from one line: a list of sessions wants a line that holds, a live session's masthead wants a line that moves. This is the finding under the other findings, and it is why the trigger cannot simply be pointed at the existing field. **(verified — three documents, one string)**

**[F07] The envelope is narrow and the synopsis field is optional.** `ObserverEnvelope` (`observer_wake.rs`) is `deny_unknown_fields` with `post: Option<ObserverPost>` and `#[serde(default)] synopsis: Option<String>`; a missing, null, empty or whitespace synopsis leaves the sentence standing. `synopsis_register_report` imposes the register — quotes off, filler openers and a leading article off, whitespace collapsed, terminal period off, clipped to `MAX_SYNOPSIS_CHARS` (72). A third field rides the same envelope under the same `default`, and an older answer shape still parses. **(verified)**

**[F08] The ledger persists the synopsis; posts have their own store.** `sessions.synopsis TEXT` (`session_ledger.rs`, `migrate_sessions_add_synopsis`) is written by `record_synopsis`, guarded so an unchanged value writes nothing; `build_session_updated_frame` (`agent_supervisor.rs`) carries it to the deck. Posts travel on the `OVERVIEW` feed into `overview-store.ts`, where `latestPostForSession` is what the account run reads. **(verified)**

**[F09] A written line has a latency tail, because the Observer's lane is shared.** `JobClass::of` (`shared_agent.rs`) maps every non-classify job to `Self::Sentence`, so `observer-post`, `operator-retrieve` and `operator-answer` share one lane across `DEFAULT_MAX_WORKERS` (3). `OBSERVER_POST_TIMEOUT` is 120 s with a slow mark at 60 s. A submission wake is usually seconds and can queue behind an Operator answer holding a worker. **(verified)**

**[F10] The account run already falls to the ask when no model has spoken.** `sessionActivity` (`session-identity-row.tsx`) reads: the compaction pin, else the newest post while a turn is in flight, else the turn's ask, else the rest sentence. [D187] states the same as the switch's behaviour — with `dev.tugapp.overview/enabled` off, "the masthead's account run falls through to the turn's ask." The ask is `latestAskForScope` off the digester's `Emission::Now` submission line, sub-second. **The no-model fallback rung is a solved pattern on the run below; the topline has no equivalent.** **(verified)**

**[F11] A window holding only the prompt is skipped at turn end, and that gate is a local-command gate.** `SessionWindow.assistant_activity` (`observer.rs`) is false until a frame passes `counts_as_assistant_activity`; a turn-end wake over a window with only the prompt and the turn's bookends is skipped, because `/model` and `/compact` open and close a turn with nothing between. A submission wake is by definition over a window of that shape, so it cannot reuse that gate and needs its own answer to the local-command case. **(verified)**

**[F12] `overview_replay` measures cadence changes against real transcripts and takes `--sitrep-secs`.** `ReplayOptions.sitrep_secs` (`overview_replay.rs`) is its one cadence knob; a submission arm needs a second one for the replay to report its wake count. **(verified)**

**[F13] Three surfaces read the ladder, and one of them is a list at rest.** `SessionIdentityRow` mounts on the masthead, on the Cards rail (`cards-session-cell.tsx`, one-line description) and in the session picker (`session-picker-cells.tsx`, `descriptionMaxChars={96}`). The picker lists sessions to resume; nothing in it is in flight from the reader's point of view. **(verified)**

---

## Decisions {#decisions}

**[B01] The Observer is woken by a submission, and that is the fix.** [F02] and [F04] are the two halves of the delay and this closes the second; [B02] closes the first. The user's call, and the brief is ordered around it.

**[B02] The envelope carries two sentences — `synopsis`, the through-line, and `current`, the per-turn line — because a trigger with nothing it may write is a faster null.** This is [F02] applied to [F06]. `synopsis` keeps its job and its rubric exactly as [F05] left them: what the session is FOR, hold unless the subject moved, ledger-persisted, read at rest and in the picker. `current` is new: what this session is on in THIS turn, in the same register ([F07]'s normalizer, the same 72-character clip, verb-first, no tools, no paths), written or revised on any wake during a turn, null meaning "what stands is still right". Both are `#[serde(default)]` so an older answer parses. One ask, two answers, unchanged from [D187]; the second answer is two fields because [F06] shows one field cannot hold both cadences.

**[B03] The topline is a currency line while a turn is in flight and an identity line at rest.** During a turn it is the `current` line; at rest it is the through-line. The masthead and the Cards rail both take this rule — the report is about both ([F13]) — and the picker keeps the identity line always, because a list of resumable sessions has no turn in flight to be current about.

**[B04] The current line is not persisted and does not touch the ledger schema.** It is a fact about a turn in flight, shown only while that turn is in flight ([B03]), so a restart has nothing to restore and `sessions` gains no column. It travels on the `OVERVIEW` feed beside the post ([F08]) into `overview-store.ts` as a per-session value, cleared when the turn ends.

**[B05] A submission arms the session's window short, once per turn, and the wake reason is `submission`.** No second timer: `handle_submission_frame` sets `armed_at` so the existing sitrep loop fires after `SUBMISSION_ARM_SECS` rather than `sitrep_secs`; the constant is a tugbank default alongside `sitrep_secs`, so it turns without a rebuild. A few seconds rather than zero, so the window holds the first tool calls as well as the prompt and the current line can name what the session is starting to do rather than restate the ask. After that wake the window re-arms at the sitrep as today. The reason rides the job input because the model uses it well ([D187]).

**[B06] A submission wake writes the current line and is told to post nothing.** [F04]'s reasoning stands for the post: a bare ask is not news, and the channel should not fill with "the user asked X". It never applied to the sentence. So the instructions say: on a `submission` wake, write `current`, and answer null for `post` and `synopsis`. The envelope is honoured as returned — Rust decides when, the model decides what ([D187]) — and `overview_replay` is where a model that posts anyway is seen.

**[B07] A submission that is a local command does not arm short.** [F11]: the `assistant_activity` gate cannot serve here, and a `/model` or `/compact` submission must not spend a Sonnet call to learn that a setting changed. The handler declines to arm short for a submission the digester does not read as an ask — the same line [D132] draws for the prompt rung — and ordinary sitrep behaviour is unchanged for it.

**[B08] The topline's no-model fallback is the turn's ask, and it is a floor rather than a feature.** [F09] gives the written line a tail, [D187]'s switch can turn the writer off entirely, and a wake may decline; a topline that goes stale in any of those cases has the reported bug in a narrower window. So while a turn is in flight and no `current` line stands for it, the topline reads `latestAskForScope`, marked as a stand-in (`descriptionStandIn`) because it is a fact standing in for a line nobody has written yet. This is [F10]'s rung, which the account run has had all along, given to the run above it for the same reason. **It is explicitly not the solve** — an earlier draft of this brief led with it, and the user's challenge is recorded in [B09].

**[B09] The instant ask is not the headline, and showing the user their own prompt is not the aim.** Recorded so it is not re-proposed as one. The ask is the least informative line on the card for the person who typed it a second earlier; it is long, it is raw prompt text on a line whose register is a written sentence, and it would be clipped on every surface that shows it. Its value is entirely as [B08]'s floor. What the reader actually wants is the Observer's line, and [B01] plus [B02] are what get it there in seconds.

**[B10] The ask stays on the account run.** An earlier draft removed it to avoid the same text on two lines during the window before the first post; that left the account run falling to `7 turns, 48.2 KB. Ready.` while a session was visibly working, which is worse than the doubling it prevented. With [B05] the doubling window is seconds, and it is the window in which both lines are honestly saying the only thing known. `sessionActivity` is unchanged by this work. The beat's return to that run is a separate question on its own merits, and is not reopened here.

**[B11] The order is [B02]'s split, then [B05]'s trigger, then [B08]'s floor.** The split first because [F02] shows the trigger is the half that was already satisfied when the bug was reported; the trigger second because it is what makes the split fast; the floor last because it covers the residue the first two leave and is the only one of the three that can be judged by watching the other two run.

**[B12] The cost is written down and measured before it ships.** [B05] adds one Sonnet call per real user turn on top of the turn-end wake — roughly double the Observer's calls on short turns. `overview_replay` gains `--submission-arm-secs` beside `--sitrep-secs` ([F12]) and reports the wake count with and without it against a recorded transcript. The number goes in the design decision, as [D187]'s did.

**[B13] [D187], [D132] and [D185] are amended.** [D187]: the envelope has three fields; the wakes are five; the submission wake, its local-command gate and its measured cost are recorded. [D132]: the description ladder has two live-turn rungs above the synopsis. [D185]: the masthead's upper line is the current line during a turn. The prior brief's [B06] (the through-line rubric) is kept in full — it is the right rubric for the field it governs, and [B02] is what stops it from being reversed a third time.

---

## Non-goals {#non-goals}

- **Making the through-line move per turn.** Rejected under [F06] and [B02]. Pointing the new trigger at the existing `synopsis` field and loosening its rubric is the obvious short version of this work and it is the wrong one: it would reverse the 2026-09-13 decision and leave the picker and the rail-at-rest unable to tell sessions apart — the exact complaint that decision answered. The oscillation ends by splitting the field, not by moving the one field a third time.
- **Leading with the instant ask.** [B09]. It is [B08]'s floor and nothing more.
- **A deck-side model, or any model, in the instant path.** [D103]: not to be re-proposed.
- **Reading the current line off the beat.** The beat is a tool call; the current line names work. [D186] keeps them apart.
- **Returning the beat to the account run.** [B10]. It was retired from there on 2026-09-13 and the line-noise defect behind that retirement was fixed the next day in `b8f8a9ffb`, which makes it worth asking again — on its own, not inside this arc.
- **Persisting the current line.** [B04].
- **A submission wake that posts.** [B06].
- **Speeding the sitrep itself.** Sixty seconds was measured ([D187]), and [F02] shows a faster sitrep would only have reached the same null sooner.
- **Changing what the picker shows.** It keeps the through-line always ([B03]).

---

## Exit {#exit}

**An arc.** The shape, in the order [B11] fixes:

1. **The split** — `ObserverEnvelope` gains `current` ([B02]); `observer.rs` normalizes it with the synopsis's register and broadcasts it on `OVERVIEW` ([B04]); `overview-store.ts` holds it per session and clears it at turn end; `sessionDescription` gains the rung and the row hook feeds it; `OBSERVER_POST_INSTRUCTIONS` describes the two sentences as two jobs; the fixture and the replay's envelope reading follow.
2. **The trigger** — `WakeReason::Submission`, `SUBMISSION_ARM_SECS` as a tugbank default, the short arm in `handle_submission_frame` gated per [B07] ([B05]); the instructions' submission-wake rule ([B06]); `--submission-arm-secs` on `overview_replay` and the measured wake count ([B12]).
3. **The floor** — the ask rung under the current line on the topline ([B08]), marked as a stand-in; `sessionActivity` untouched ([B10]); `session-description-ladder.test.ts` gains the rows, and an app-test in the shape of `at0565` pins that the topline shows the current line when one stands, the ask when none does, and the through-line at turn end.
4. The amendments in [B13], with the measured number from [B12] in [D187].
