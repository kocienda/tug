# Spike capture — PULSE commentator voice, raw `claude` stream-json

Raw upstream `claude` stream-json capture (unnormalized, single-run, no schema)
taken to pin the PULSE commentator's posture, prompt, digest format, and latency
envelope (`dash/pulse.md`). Same conventions as `../v2.1.173-jobs-spike/`:
this is the **raw claude layer**. The findings here are constants in the
`tugpulse` daemon; re-run the probe on a future claude release to re-verify.

## Files

| File | Captured | Notes |
|------|----------|-------|
| `test-pulse-voice-raw.jsonl` | `claude 2.1.173`, 2026-06-12 | One 54-line persistent session: 18 scripted **v6** beat digests (single-scope beats from two interleaved sessions, real event excerpts, `assistant says:` lines, a thread-separation trap, 2 thin-but-triggered beats) against `claude-haiku-4-5` under the pinned posture and the v6 prompt. Produced by `probes/probe-pulse-voice.mjs`. |
| `probes/probe-pulse-voice.mjs` | 2026-06-12 | The harness: spawns the pinned posture, drives the beats, sequence-pairs each beat with its result frame, validates line shape (≤110 chars, single line, no repeats, PASS detection), measures wall-clock per beat. Carries the v6 prompt + digests. Re-run with `bun probes/probe-pulse-voice.mjs <out.jsonl>`. |

## The pinned daemon posture

```
claude --output-format stream-json --input-format stream-json --verbose \
       --model claude-haiku-4-5 \
       --permission-mode default \
       --setting-sources "" \
       --disallowedTools <every tool in the release's init-frame vocabulary> \
       --append-system-prompt <the PULSE prompt>
env: MAX_THINKING_TOKENS=0 (plus the usual ANTHROPIC_* auth scrub)
```

Every element above was forced by a measured failure, not chosen a priori:

- **`--model claude-haiku-4-5` exact.** The alias `--model haiku` was NOT
  honored on 2.1.173 — the session silently ran `claude-sonnet-4-6`.
- **`--permission-mode default` + full `--disallowedTools`; plan mode REJECTED.**
  The plan document assumed `--permission-mode plan` as the no-tools posture.
  Measured: plan mode permits read-only tools, and the model used them — 12
  Bash calls and 2 Agent spawns "investigating" the digests, 9–19s beats, plus
  task/wake frames polluting the stream. Disallowing the release's entire tool
  vocabulary (from the init frame's `tools` array — the CLI hard-errors on
  unknown names, so the list must track the release) yields zero tool use.
- **`--setting-sources ""`.** The user's global `alwaysThinkingEnabled: true`
  reached the commentator and cost 6–14s of thinking per one-line beat.
  Settings isolation does NOT touch auth (OAuth/keychain credentials are not a
  settings source) — the session still rides the user's subscription.
- **`MAX_THINKING_TOKENS=0`** as belt-and-braces with the above.
- **`--bare` is unusable** despite being the obvious "minimal mode": it never
  reads OAuth/keychain (API-key only), which breaks the facility's decisive
  auth constraint.
- **Don't block on `system/init`.** With `--setting-sources ""` the init frame
  arrives only after the first input; stdin buffers safely, so the daemon just
  writes when ready.

## The system prompt (v5 — SUPERSEDED by the v6 section at the end of this file)

```
You are PULSE, the color commentator on an AI coding assistant at
work. Your audience is the developer who gave the assistant its
instructions; your job is the look behind the scenes — what the
assistant, its tools, its subagents, and its background jobs are
DOING to carry the work out: the approach taking shape, progress,
detours, errors and recoveries, interesting choices.

You have no tools — never attempt to investigate anything; everything
you know arrives in the digests. Each user message is a beat digest:
factual lines about the assistant's actions, grouped under scope tags
like [a1b2]. A line starting "context:" is the developer's standing
request — use it to interpret the work, but NEVER restate, summarize,
or echo it: the developer wrote it and knows what they asked.
Narrate only the execution.

THE DIGEST IS YOUR ONLY SOURCE OF TRUTH. Every fact states what
actually happened — "ok" means it succeeded, "failed" means it
failed. Never assert anything the digest does not state: no guessed
outcomes, no invented errors, no speculation about availability or
causes. If you cannot say something true and grounded, say PASS.

Reply with EXACTLY ONE plain-text line — aim for 60–90 characters,
never exceed 110. Your DEFAULT IS TO SPEAK — every beat deserves a
line unless it genuinely adds nothing your previous lines didn't
already carry. Reply with exactly PASS for those nothing-new beats.
Never invent drama; quiet specificity beats hype.

When you speak:
- Present tense. Name specifics: files, commands, counts, durations.
- Say what the assistant's actions MEAN — the approach, the pattern
  in a burst of calls, a reversal, a milestone — not a restatement
  of single events. Repeated calls on one file read as a struggle or
  a sweep; a burst of reads before an edit reads as reconnaissance;
  say so.
- Never repeat information any of your previous lines already carried.
- When two scopes appear, weave them or pick the more notable one.
- No filler, no hype, no emoji, no markdown, no surrounding quotes.
```

Prompt iterations, for the record:
1. v1 (no PASS-default, "110 maximum"): good interpretive lines but PASS never
   fired (0/4 routine beats) and 3 lines ran 111–124 chars — the
   manufactured-content trap in miniature.
2. v2/final (PASS-default + intent-narration ban + 60–90 target): 4/4 routine
   beats PASS, 0 over-length, 0 repeats. The model errs toward silence on
   borderline developments (it PASSed a turn-start and a recovery beat in the
   final run) — accepted deliberately: under-narration is the safe side of the
   bland-commentary risk, and the prompt is a tunable constant.
3. v3/shipped (SPEAK-default): live integration showed v2's PASS-default
   double-filtering — the production producer already emits only notable
   events, so the commentator muted nearly every real beat (zero lines across
   three live turns). The shipped contract: the producer is the filter, the
   commentator is the phrasing — default SPEAK, PASS reserved for beats adding
   nothing the previous lines didn't carry (verified: a duplicate turn-end
   fact PASSes, a coalesced turn-start + first-tool beat speaks).
4. v4/shipped (execution-facing): v3 narrated the WRONG SUBJECT — it summarized
   the developer's requests back at them ("turn start: user asked …" facts led
   straight there). PULSE's subject is the execution: what the assistant, its
   tools, subagents, and jobs are doing — approach, progress, reversals,
   nuances. The producer now emits every tool call (with repeat ordinals),
   task/job transitions, and substantive turn-end summaries; the request rides
   as a `context:` fact the prompt forbids echoing. Verified lines:
   "Investigating background-job tracking surface: read telemetry renderers
   and reducer, searched for task_started…", "Rapid edits to select-jobs.ts
   hit a conflict; second write failed mid-sweep." 
5. v5/shipped (grounded outcomes): v4 handed the model tool CALLS without
   outcomes, and under speak-pressure it fabricated one — a clean tokei run
   narrated as "Tokei unavailable; assistant unable to execute line-count
   analysis without the tool." Two-sided fix: tool facts now fire at the
   RESULT carrying the true outcome + duration ("Bash: tokei — ok (6s)",
   "Edit on reducer.ts — failed (2nd time this turn)"), and the prompt pins
   the digest as the only source of truth (no guessed outcomes, no invented
   errors; PASS over speculation). The failing scenario replayed: "tokei
   scanned the repo, 6s runtime." 

## The pinned digest format

```
BEAT <n>
[<scope-short-id>]
- <producer-written fact sentence>
- <producer-written fact sentence>
[<other-scope>]
- <fact>
```

## Measured latency (final posture, 20 beats)

| run | min | p50 | p90 | max | >4s |
|-----|-----|-----|-----|-----|-----|
| final | 550ms | 733ms | 1464ms | 1518ms | 0 |
| prior (same posture) | 614ms | 788ms | 3441ms | 3521ms | 0 |

The ~4s stale-drop window in the daemon's beat discipline is comfortable: worst
observed beat across both runs is 3.5s; typical is sub-second. (For contrast:
with thinking leaking in, beats ran 6–14s; with plan-mode tool use, 9–19s and a
30s timeout.)

## Question resolutions (for `dash/pulse.md`)

- **[Q01] multi-scope beats — RESOLVED: one digest, scope-tag grouping, no
  per-scope beats needed.** Haiku wove the two-scope arc coherently and
  unprompted ("Two parallel tracks: polish jobs popover, write Monitor
  lifecycle probe"; "Popover rows done, probe captured 412 lines") and kept
  per-scope progress straight across interleaved beats.
- **[Q02] minimal driving — RESOLVED: a thin new driver; none of tugcode's
  session machinery.** Across every run: zero `control_request` traffic and
  zero permission round-trips under the pinned posture. The daemon needs only:
  the spawn-args constant, the auth-env scrub, newline-split stdout JSON
  parsing, user-message sends, and **sequence-paired** result-frame reads
  (pair beat N with result frame N — a timeout must consume its slot, or every
  later reply shifts one beat off; measured failure mode in the harness's
  first run).

---

## v6 — the watch-the-wire rework (`dash/pulse-2.md`)

The producer layer was deleted (it hand-phrased note-card facts and silently
starved the model — see the plan's context); the daemon now digests
session-tagged wire frames directly. v6 re-pins the voice for the new shape:
**single-scope beats** (one beat queue per session), **real event excerpts**,
and an **`assistant says:`** line harvested from the assistant's own
interstitial text. The posture is unchanged from the table above.

### The v6 system prompt (verbatim daemon constant — `tugcode/src/pulse/posture.ts`)

```
You are PULSE, the color commentator on an AI coding assistant at
work. Your audience is the developer who gave the assistant its
instructions; your job is the look behind the scenes — what the
assistant, its tools, its subagents, and its background jobs are
DOING to carry the work out: the approach taking shape, progress,
detours, errors and recoveries, interesting choices.

You have no tools — never attempt to investigate anything; everything
you know arrives in the digests. Each user message is a beat digest
about EXACTLY ONE session, named by the tag in its header (like
[a1b2]). Different tags are different sessions doing unrelated work:
keep them as separate narrative threads. The never-repeat rule
applies within one session's thread — a line about one session is
never redundant because you said something similar about another.

A digest line starting "assistant says:" carries the assistant's
own words about what it is doing — use it to understand the why
behind the actions, but never quote or echo it; narrate the work in
your own voice. Every other line is an event that actually happened:
"ok" means it succeeded, "failed" means it failed, and quoted
excerpts are real output. THE DIGEST IS YOUR ONLY SOURCE OF TRUTH.
Never assert anything it does not state: no guessed outcomes, no
invented errors, no speculation about availability or causes. If you
cannot say something true and grounded, say PASS.

Reply with EXACTLY ONE short plain-text line: one sentence, at most
SIXTEEN WORDS, never more than 110 characters. A reply that runs
long is WRONG no matter how good its content — pick the single most
notable thing and say only that.
Your DEFAULT IS TO SPEAK — but a beat that is only routine
housekeeping (a lone successful read, a re-check) deserves exactly
PASS unless it reveals something new about the approach. Also PASS
any beat that adds nothing your previous lines for that same session
already carried. Never invent drama; quiet specificity beats hype.

When you speak:
- Present tense. Name specifics: files, commands, counts, durations.
- Say what the assistant's actions MEAN — the approach, the pattern
  in a burst of calls, a reversal, a milestone — not a restatement
  of single events. Repeated calls on one file read as a struggle or
  a sweep; a burst of reads before an edit reads as reconnaissance;
  say so.
- Only what IS, only what the digest states. Never "likely",
  "probably", "seems"; never prescribe or predict what comes
  next; never add purposes, phases, or causes the digest didn't
  state (if it says tests passed, the line says tests passed — not
  what they validated "against" or what that "readies").
- Never name a session or its tag — your line is shown on that
  session's own display; the reader already knows which session.
  When a turn completes, say what landed, not who finished.
- No filler, no hype, no emoji, no markdown, no surrounding quotes.
```

### The v6 digest format (single scope per beat)

```
BEAT <n>
[<scope-short-id>]
assistant says: "<text harvested since this scope's last beat, clipped to 240 chars>"
- <tool_name><hint> — ok|failed (<Ns>) (<k>th time this turn)
- <tool_name><hint> — failed: "<real output excerpt, ≤120 chars>"
- background job started|completed: <description> (<Ns>)
- task added|marked <status>: "<subject>"
- the assistant's connection to its AI model is retrying (attempt <n>/<max>): "<error>"
- turn complete: "<result excerpt>" | turn cancelled
```

The `assistant says:` clip budget is **240 chars** (real-session interstitial
text blocks run ~96 chars median; 240 holds two typical notes). Error events
always quote real output. The API-retry phrasing names "the assistant's
connection to its AI model" explicitly — the terser "API retry 1/10" was
misattributed by the model to the session's own subject matter ("harness
hitting upstream service exhaustion").

### v6 prompt iterations

6. **v6.0** (single-scope + thread rules + assistant-says): substance good,
   trap beat passed (a tests-green line for session B despite session A's
   earlier tests-green line) — but 7/18 over-length, 0/2 PASS on thin beats,
   scope tags leaking into lines ("Back in a1b2…"), one speculation
   ("Likely wiring…").
7. **v6.2** (hard char limit + housekeeping-PASS rule + no-speculation +
   no-tags): PASS 2/2, repeats 0 — but still 5/18 over-length (Haiku cannot
   count characters; 215-char worst) and turn-complete beats named sessions
   ("Session a1b2 wrapped").
8. **v6.4/final** (SIXTEEN WORDS framing + "say what landed, not who
   finished" + no-added-purposes rule + retry rephrasing): 1/18 marginal
   overrun (117 chars; the daemon's defensive 110 clip covers it), thin-beat
   PASS, no session naming, no attribution misses, no invented causes.
   Sample lines: "Reconnaissance before changes: checking how task state
   moves through reducer and what telemetry fires on transitions.",
   "Type mismatch on JobKind assignment in select-jobs.ts line 88 — selector
   return type needs narrowing.", "Jobs selectors shipped, test suite clean."
   Residual texture, accepted: occasional mild prescription ("needs
   narrowing"), and the model PASSes a first-of-ten API retry (defensible —
   the daemon's retry stride resurfaces persistent retries).

### v6 measured latency (18 beats per run, 3 runs)

| run | min | p50 | p90 | max | >4s |
|------|-----|-----|-----|-----|-----|
| v6.4/final | 652ms | 917ms | 1471ms | 2286ms | 0 |
| v6.3 | 574ms | 826ms | 1129ms | 1410ms | 0 |
| v6.2 | 724ms | 870ms | 1362ms | 1691ms | 0 |

### Question resolution (for `dash/pulse-2.md`)

- **[Q01] digest v6 + prompt v6 — RESOLVED.** The format above and the v6
  prompt produce short, truthful, non-repeating lines; per-thread separation
  holds (the trap beat speaks); the `assistant says` line is interpreted, not
  echoed; clip budget pinned at 240. Zero control traffic, zero tool use,
  `claude-haiku-4-5-20251001` confirmed on every run.

### v7 — the live-walk corrections (first walk of `dash/pulse-2.md`)

The first live walk surfaced four voice/liveness defects; v7 fixes them with
**digest material + prompt** changes (and daemon trigger changes outside this
spike's scope — tool-start triggers, a 10s still-running tick, 4s min interval):

- **Laggy, after-the-fact narration** → tool calls now trigger beats at START
  (the digest renders `— running`), open calls ≥10s earn one `— still running
  (Ns so far)` event, and the digest carries a `running now:` section plus a
  `turn so far:` arc line (calls, files, failures) — pattern material so the
  one-event-per-beat flatness of the walk's log can't recur.
- **Past-tense framing** → LIVE PRESENT TENSE rule with examples; verified:
  "Tests running on Rust side, 14 seconds elapsed", "Mapping task transition
  logic across reducer and telemetry renderers before making changes."
- **Actor references** → banned words "assistant"/"user"/"developer"/"AI";
  verified zero across all working beats. Residual: the no-tool greeting turn
  ("Greeted user on the tugdash branch") — the actor word is the work itself
  there; accepted after three iterations.
- **First message produced no pulse** (the walk's beat 1 PASSed a greeting
  turn) → THE PASS BAN: failures, turn completions, and a session's first
  activity must speak; a no-tool turn gets an actor-free kind-of-turn line.
  Verified speaking in the final run.

Final v7 run (19 beats): p50 948ms, max 1586ms, 0 over-4s, PASS 2/2 on
expected, 0 over-length, 0 repeats, retry beat narrated. The capture file
carries this run.

### v8 — color, not play-by-play (second walk of `dash/pulse-2.md`)

The second walk's verdict: v7 lines restated the transcript ("Haiku
summarized a 294k-line codebase…") — well-phrased play-by-play, worthless
beside a visible transcript (and it leaked a model name). v8 rebuilds the
voice around THE BAR: a line must say something the transcript does not —
the read BETWEEN events. Five sources: pattern reads (edit storms,
recon bursts, haste), arc/inflection (first failure, first green after red,
reversals), intent-vs-action, the shape of a stumble/recovery, notable
magnitudes. Voice direction (user-picked): grounded analyst — every read
anchored on stated files/counts/outcomes, minimal chat.

Mechanism: **few-shot exemplars** mined from real session histories (an
edit-storm-with-missed-anchor arc, a writes-before-reads stumble cluster,
a prompt-rework payoff, plus PASS exemplars for greetings/recon/routine
progress) — the lever rules alone never reached across seven prompt
versions. Strict default-to-silence; failures and hard reversals must
speak, and a noted failure's recovery closes its arc. Model names join
the banned words.

Final v8 run (19 beats): 14 PASS (4/4 on expected), 5 spoken lines, all
earned reads — "Type mismatch at select-jobs.ts line 88", "Type error
resolved with union narrowing", "Focus restored — responder chain edit
landed on first try", "Pulse CSS landed after three passes". 0
over-length, p50 931ms. The capture carries this run.

---

## Terminal note: the commentator is retired; the ticker replaces it

After v8's walk the verdict held across the whole explored space: spoken
often, the lines restated a transcript the developer reads natively; spoken
rarely, the surface was unpredictable ("no feel for what this thing will
do"). Color commentary has no stable niche beside a fully legible game. The
strip's real value was legibility of the PRESENT during long turns — so the
daemon now runs a deterministic per-scope ticker (`pulse/ticker.ts`): current
call label, elapsed refreshes, failures/recoveries, jobs, per-turn summary.
No model, no prompt, no latency, nothing to fabricate. This capture
directory remains as the record of the commentator era — posture findings
(model pinning, tool disallowance, settings isolation, sequence pairing)
still apply to any future claude-subprocess feature.

## Final form: the voice mirror — the machine thinking out loud

The latch concept was superseded before it shipped (user direction): the
pulse is the machine's own running monologue. `pulse/voice.ts` mirrors the
worker's `assistant_text` interstitial narration to the strip verbatim —
the latest settled sentence while the turn works (change-driven, ~1s
throttle, light markdown strip, 110 clip), `done` on turn completion,
`stopped` on cancellation, cleared deck-side on submit. In its own words:
nothing to fabricate, no second model, fully deterministic. Replayed
against real session histories the strip reads exactly as intended:
"Checking it.", "Folding the three fixups into the plan now…", "Now the
green baseline in the worktree."
