<!-- devise-skeleton v4 -->

## Pulse Rearchitecture — The Pulse Follows the Transcript, Not the Toolbelt {#pulse-rearchitecture}

**Purpose:** Rearchitect the session-overview emitter so the pulse headline follows *everything* that streams into a session's transcript — assistant prose, tool calls, and Session-card shell commands — on a clock-driven cadence, with an incremental prompt read that stops re-parsing multi-megabyte JSONLs on every tick.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-07-29 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The pulse overview (`tugrust/crates/tugcast/src/feeds/session_overview.rs`) was built as a tool-telemetry summarizer when the feature it needs to be is a transcript follower. Its definition of "something happened" is `session_beat`, which recognizes exactly two frame types — `tool_use` (a digest line) and `turn_complete` (a bare counter tick) — so the assistant's own prose, the one place the session states its intent in natural language, never reaches the local model. The Session card's `$` shell route is invisible twice over: it runs on `SHELL_INPUT`/`SHELL_OUTPUT` (`feeds/shell.rs`), a wire the overview task never subscribes to, so a typed command contributes neither a digest line nor a cadence advance. And the emitter loop is purely frame-driven — the `select!` in `session_overview_task` has only cancel and `code_rx.recv()` arms, with `Cadence::fires` hard-returning `false` at `new_frames == 0` — so a stretch of pure prose can never fire, the 30-second idle path cannot rescue it, and the final stretch of every session goes unsummarized because no further frames arrive to trigger the check.

Two further defects compound this. The digest outvotes its own subject: a tick's "right now" section holds roughly `BURST_FRAMES` (8) lines against up to 32 background tool lines and 10 prompts, and the 2-bit 8B model is asked to headline the smallest section of its input. And the prompt read is unbounded: every tick calls `crate::scribe::session_prompts_since(&jsonl, 0, …)`, which `read_to_string`s and JSON-parses the entire session JSONL inline in the async loop — transcripts in this repo run to 51MB, and a faster clock-driven cadence makes this graduate from wasteful to unacceptable.

The prior liveness plan (`dash/local-model-liveness-completion.md`, landed on main) fixed the prompt's subject and gave the digest a recency split, and shipped the measurement layer this plan will be judged with: structured `local model request` lines from both transports, the `session overview: summarized` line with register-report fields, and `just model-stats` / `just model-liveness`. The measured baseline is a 44% headline change rate (87/199) on the pre-split build.

**Addendum (post-Step-7 live vetting).** Steps 1–7 landed and the mechanics verified, but the first live conversational session (proper-coast/50857d9a) showed the pulse still trailing the person it serves: msg 1 submitted at 15:51:10, the whole turn over by ~15:51:28, and the *first overview ever* — "Explain Maxwell's equations" — emitted at 15:51:34.5, three hundred milliseconds after msg 2 (a different topic) was submitted. Three structural gaps compound into that behavior: the user's submission is not a beat (the emitter never hears the one event that says the session's subject just changed), the cadence applies its anti-twitch floor and idle thresholds to the opening line and to re-aims (a 10–20s conversational turn fits entirely inside the pulse's reaction window), and the digest's "right now" section is emit-relative rather than turn-relative (a sparse-emit stretch makes "right now" span the whole previous turn, so the first emit after a new prompt narrates the old one). Steps 8–10 close these: the throughline extends to **the pulse follows the transcript, and the human leads it** — a human act (a submission, a `$` command) re-aims the pulse immediately instead of waiting its turn behind the response.

#### Strategy {#strategy}

- One throughline applied at every seam: **the pulse follows the transcript, not the toolbelt.** The digest becomes a compressed transcript — prose, tool calls, and shell commands interleaved in arrival order — and everything the transcript shows advances the cadence.
- Widen `SessionBeat` into the unifying vocabulary (`Tool`, `Said`, `Shell`, `Turn`) rather than building a new activity-bus abstraction: the enum is the bus, and the wires behind it (two broadcast subscriptions) can multiply later without touching consumers.
- Give the emitter a clock: a tick arm in the `select!` sweeps sessions and evaluates cadence against elapsed time, so frame arrival becomes evidence accumulation instead of the trigger.
- Lower the cadence floors within the existing timeout ladder — liveliness is an essential element of the pulse — while keeping `SUMMARIZE_TIMEOUT < EMIT_FLOOR` so the cadence stays designed rather than inference-bound.
- Fix the prompt read structurally (incremental tail reads with a per-session byte offset, off the async thread), not by tuning the full-file parse.
- Rebalance the digest by measurement, not intuition: candidate budgets go through the existing `tests/model-eval` harness with a corpus regenerated to the new compressed-transcript shape before any constant ships.
- Sequence pure-logic work first (beat vocabulary, accumulation, cadence) so every step lands with paused-clock `bun`-free Rust tests, and wire the app build + live verification at the end.

#### Success Criteria (Measurable) {#success-criteria}

- A session doing pure assistant prose (zero `tool_use` frames) produces an overview within `IDLE_PERIOD` of the first prose beat — proven by a paused-clock Rust test that sends only `assistant_text` deltas and advances time (`cargo nextest run -p tugcast session_overview`).
- A session doing only `$` shell commands (zero CODE_OUTPUT beats) produces an overview — proven by a paused-clock Rust test that publishes only `exchange_started`/`exchange_complete` frames on the shell broadcast.
- The final stretch of a session is summarized with no trailing frame: a paused-clock test sends a burst, waits out the floor with zero further frames, and asserts an emit fired from the tick arm alone.
- The per-tick prompt read is incremental: a Rust test appends lines to a temp JSONL between reads and asserts the second read parses only the appended bytes (byte-offset observable via the cache struct), and the first prompt survives eviction.
- The regenerated model-eval corpus (compressed-transcript digests with `said:` and `$` lines) scores at parity or better with the current 12/12 register pass — `just model-eval` against the debug instance.
- Live headline change rate improves over the 44% (87/199) baseline — `just model-stats <instance>` after a real working session on the new build; the comparison is recorded in the dash round summary, not asserted by a test.
- `at0282-pulse-two-level.test.ts` still passes unchanged (`just app-test tests/app-test/at0282-pulse-two-level.test.ts`) — the PULSE frame contract (`overview_frame`) is untouched.
- A live user submission produces an overview aimed at the new prompt within one tick plus inference — proven by a paused-clock test (submission event mid-quiet-stretch → emit at the next tick with the ask last in the digest's prompt section, floor and idle untouched) and by replaying the proper-coast scenario live in Step 10: two conversational asks in a row, each headlined before its turn completes.
- The first emit after a new ask carries no stale "right now": a paused-clock test runs a full turn, lets it emit, submits a new ask, and asserts the next digest's "What it is doing right now:" section carries the fresh ask verbatim as its sole line (no old activity) while the old turn's lines sit in background. (Amended during Step 10: the original shape — omit the section entirely — left the digest ending on the old turn's background, and the eval showed the model headlining that background instead of the directive; a digest whose asks have moved past the opening goal now ends on the newest ask *as* the right-now section. A meta-prefix like "taking up:" on that line makes the model discount it as commentary — the ask rides verbatim.)

#### Scope {#scope}

1. Widen the beat vocabulary: `SessionBeat::{Tool, Said, Shell, Turn}` with an interleaved activity line per content-bearing beat (Spec S01).
2. Prose beats from live `assistant_text` deltas: per-block accumulation, early beat at a head threshold, keyed dedup against replay/reconnect snapshots (Spec S02).
3. Shell beats: subscribe the overview task to the `SHELL_OUTPUT` broadcast; `exchange_started` and `exchange_complete` both beat (Spec S01, [P03]).
4. Clock-driven emitter: tick arm, per-session cadence sweep, lowered floors (Spec S03, [P04], [P05]).
5. Incremental prompt cache: per-session byte offset, first-prompt retention, `spawn_blocking` reads (Spec S04, [P07]).
6. Digest rebalance: compressed-transcript layout, background clip, first + recent prompts, budgets validated through model-eval with a regenerated corpus (Spec S05, [P06]).
7. Submission beats: tap the CODE_INPUT wire for live `user_message` submissions; the ask reaches the emitter the moment it happens (Spec S06, [P08]).
8. Human acts re-aim the pulse: a submission (or a `$` command starting) resets the recency boundary and force-fires the next tick, floor and idle bypassed; the newest ask rides the digest as the current directive (Spec S06, S07, [P09], [P10]).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Shell-command *classification* quality (`LocalModelPrompts.classify` and a classify eval register) — a follow-on plan; this plan's shell beats are the plumbing it will feed on.
- Deck-side rendering changes — the `overview_frame` wire shape (`kind: "overview"`) is unchanged and tugdeck is untouched.
- A generalized "session activity bus" — rejected in [P01]; the widened enum covers today's two wires.
- `thinking_text` beats — thinking is not what the session is *doing*, and the frame is not on `PULSE_FORWARD_ALLOWLIST` anyway; excluding it is deliberate.
- Rewriting `LocalModelPrompts.summarize` — the prompt stays frozen this plan unless the model-eval gate in Step 6 forces a wording touch ([Q02]).
- The dev-panel promotion of liveness numbers ([P07] of the prior plan's roadmap) and `NSLog`→`TugLog` migration — unrelated follow-ons.

#### Dependencies / Prerequisites {#dependencies}

- The landed liveness plan's measurement layer: `session overview: summarized` tracing fields, `local model request` lines from `LocalModelService.handle`, `tests/model-eval/{run,analyze,liveness}.py`, `just model-stats` / `just model-liveness` / `just model-eval`.
- The `corpus_digests_are_what_compose_digest_produces` pin test in `session_overview.rs` and its `TUG_REGENERATE_DIGESTS=1` regeneration path.
- A resident local model on the test machine for Step 6's eval runs (`ternary-bonsai-8b-2bit`); the pure-logic steps need none.
- `tokio` `test-util` (already in tugcast dev-dependencies) for paused-clock tests.

#### Constraints {#constraints}

- Warnings are errors (`-D warnings` via `tugrust/.cargo/config.toml`).
- The timeout ladder must stay ordered: `CLASSIFY_SLOW(1s) < CLASSIFY_TIMEOUT(2s) < SUMMARIZE_SLOW(3s) < SUMMARIZE_TIMEOUT(6s)`, and `SUMMARIZE_TIMEOUT < EMIT_FLOOR` — the assert lives in `local_model.rs` against the `pub const EMIT_FLOOR`.
- The overview stays one-way ([D-series doctrine in the module header]): it taps broadcasts and produces only a PULSE frame and tracing; no client state reads, no request answering, no backpressure on any session.
- The emitter must cost nothing when it can't run: every missing precondition ends the tick silently.
- `LocalModelPrompts` strings are frozen by default; a change requires an explicit decision and eval evidence.
- The digest heading count is capped at three sections — a small quantized model given four or five headings starts answering about the headings (prior plan's finding).

#### Assumptions {#assumptions}

- `assistant_text` on the live path is a per-delta stream (`is_partial: true`, `text` = fragment) with **no** terminal `is_partial: false` frame at block end; terminal frames appear only on synthetic/replay/reconnect-snapshot paths (verified in `tugcode/src/session.ts` — deltas at the `text_delta` mapping, terminals only in synthetic emission, slash-command stdout echo, and the reconnect consolidated snapshot).
- `exchange_started` and `exchange_complete` SHELL_OUTPUT frames are self-contained: both carry `command`; complete also carries `exit_code`, `duration_ms` (verified in `feeds/shell.rs` — the settle frame repeats the command by design).
- `SessionScopedFeed::publish` splices `tug_session_id` into every SHELL_OUTPUT payload, so the overview can route shell frames by the same field it routes CODE_OUTPUT frames by.
- SHELL_OUTPUT carries no replay brackets — restore goes through CONTROL ledger reads, not feed replay (per the registration comment in `main.rs`) — so every shell frame the subscription sees is live work and needs no mute set.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Final digest budgets (OPEN → resolved in Step 6) {#q01-digest-budgets}

**Question:** The exact values for the rebalanced digest — background activity lines, recent-prompt count, prose-line clip length.

**Why it matters:** These are model-facing proportions; guessed values are how the current imbalance shipped.

**Options (if known):** Starting candidates in Spec S05 (12 background lines, first + 2 recent prompts, 100-char prose clip).

**Plan to resolve:** Step 6 regenerates the corpus at candidate budgets and scores with `just model-eval`; the shipped constants are whatever scores at parity-or-better with the least input.

**Resolution:** OPEN — deliberately resolved by measurement inside this plan, not before it.

#### [Q02] Does `LocalModelPrompts.summarize` need a wording touch for the mixed-voice digest? (DEFERRED) {#q02-summarize-prompt}

**Question:** The digest gains `said:` and `$` line prefixes; does the frozen summarize prompt need to name them?

**Why it matters:** The frozen-prompt rule exists because prompt churn is the most expensive kind; but a model confused by `$` prefixes would tank the register.

**Plan to resolve:** Step 6's eval run is the gate: if the regenerated corpus scores at parity with the prompt unchanged, the prompt stays frozen. Only a measured regression reopens it, and then with the same A/B discipline the prior plan used (revert → rebuild → re-run on the same instance).

**Resolution:** DEFERRED to Step 6's checkpoint; default is no change.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Prose-beat flood inflates inference rate | med | med | one `Said` beat per text block, floor unchanged as hard spacing | `just model-stats` shows summarize call rate ≫ 1 per floor interval |
| Mixed-voice digest confuses the 2-bit model | high | med | Step 6 eval gate before constants ship; [Q02] fallback | register pass rate drops below current 12/12 |
| Tick sweep + inline `await` serializes multi-session emits | low | med | accepted: one shared model serializes inference anyway; note in code | a session's emit visibly starves another's |
| Reconnect-snapshot `assistant_text` double-counts prose | med | low | keyed dedup on `(msg_id, block_index)` (Spec S02) | duplicate `said:` lines in a digest |
| `exchange_complete` payloads are large (full `output` field) | low | low | parse only `type`/`command`/`exit_code`; never store output | overview task memory growth |
| Forced fires raise the inference rate | low | med | human acts are typing-speed-bounded; digest/headline dedupes still gate the wire; `just model-stats` watches | summarize call rate tracks command rate 1:1 over a working stretch |
| The model headlines old background instead of the new ask | med | med | recency reset empties "right now"; ask rides newest-last in the prompt section; Step 10's corpus entry + eval gate | ask-shaped corpus entry fails the register or headlines the background |

**Risk R01: Prose beats raise the inference bill** {#r01-prose-beat-flood}

- **Risk:** Counting prose as evidence makes busy sessions hit the burst threshold faster, increasing summarize calls.
- **Mitigation:** One beat per text block (not per delta); `EMIT_FLOOR` remains a hard minimum between inferences; back-off ladder unchanged.
- **Residual risk:** A long multi-block turn still ticks more often than today — that is the point (liveliness), and `just model-stats` watches the rate.

**Risk R02: The register degrades on compressed-transcript digests** {#r02-register-regression}

- **Risk:** `said:`/`$` prefixes are new vocabulary for a model whose prompt never mentions them.
- **Mitigation:** Corpus regeneration + `just model-eval` gate in Step 6 before budgets/wiring are declared done; [Q02] holds the prompt-touch escape hatch.
- **Residual risk:** The eval corpus is 12 entries; live drift beyond it is caught only by `just model-stats`.

---

### Design Decisions {#design-decisions}

#### [P01] The widened enum is the bus (DECIDED) {#p01-enum-is-the-bus}

**Decision:** `SessionBeat` grows to `Tool`, `Said`, `Shell`, `Turn`; no new activity-bus infrastructure is built.

**Rationale:**
- A dedicated bus would have exactly two publishers today; the enum unifies at the type level for free.
- Two subscriptions in one `select!` is idiomatic tokio and keeps the module's one-way doctrine intact.

**Implications:**
- `SessionState.tools` is renamed to an interleaved activity deque; every content-bearing beat appends one line.
- A future third wire adds a `select!` arm and a mapping function, nothing else.

#### [P02] Prose beats fire from accumulated deltas, once per block, early at the head (DECIDED) {#p02-prose-beats}

**Decision:** The overview accumulates live `assistant_text` deltas per `(msg_id, block_index)` and emits exactly one `Said` beat per block — as soon as the accumulated head crosses the prose-clip threshold (first sentence boundary or the char cap, whichever first), or at finalization for shorter blocks.

**Rationale:**
- The live wire has no terminal frame at block end; waiting for one would mean never beating (see #assumptions).
- Beating at the head threshold instead of block end is liveliness: the digest line only needs the block's opening, and the beat lands while the prose is still streaming.
- One beat per block keeps `new_frames` meaning "one narratable event," not "one network packet."

**Implications:**
- Per-session accumulation state with a seen-set for beaten keys; `is_partial: false` frames for an already-beaten key are dropped (reconnect-snapshot dedup).
- Finalization for short blocks: a delta for a *new* key finalizes the previous open key; `turn_complete` finalizes any open key.
- Accumulation stops at the cap — the tail of a long block is never buffered (bounded memory).

#### [P03] Both shell exchange frames beat; failure is the narratable completion (DECIDED) {#p03-shell-beats}

**Decision:** `exchange_started` always beats with a `$ <command>` line; `exchange_complete` always advances the cadence, and contributes a line only on nonzero exit (`$ <command> → exit N`).

**Rationale:**
- Liveliness is an essential element of the pulse (user direction): a command starting and a command settling are both transcript events.
- A zero-exit completion adds no information beyond its own started line; a failing command is highly narratable.

**Implications:**
- The complete frame is self-contained (carries `command`, `exit_code`) so no exchange-id→command map is needed.
- `shell_state`, `path_commands`, and any other SHELL_OUTPUT types are ignored.
- The zero-exit completion is `SessionBeat::Shell(None)` — a shell beat with no line — never `SessionBeat::Turn`, because `Turn` carries prose finalization and `beaten`-clearing side effects that must key off CODE_OUTPUT turn frames only (Spec S02).

#### [P04] The emitter runs on a clock; frames are evidence, not triggers (DECIDED) {#p04-clock-driven}

**Decision:** `session_overview_task` gains a `tokio::time::interval` tick arm; each tick sweeps `sessions` and evaluates `Cadence::fires` per session against real elapsed time. Frame arrival only accumulates state.

**Rationale:**
- Fixes lag (emits fire when due, not when the next frame happens by), freeze (prose-only stretches), and the never-summarized final stretch in one structural move.
- The paused-clock test infrastructure from the prior plan covers it directly.

**Implications:**
- `Cadence::fires`'s `new_frames == 0` guard changes meaning to "nothing new since last emit" — correct once prose and shell count as new.
- Multiple due sessions on one tick emit serially through the shared model; accepted per Risk table.
- The per-frame cadence check in the frame arm is removed — the tick is the sole evaluation point (2s granularity is well inside every floor).

#### [P05] Lower floors, ladder preserved (DECIDED) {#p05-cadence-numbers}

**Decision:** `EMIT_FLOOR` 15s → **8s**, `IDLE_PERIOD` 30s → **20s**, tick interval **2s**; `BURST_FRAMES` stays 8.

**Rationale:**
- Liveliness within reason (user direction); 8s keeps `SUMMARIZE_TIMEOUT(6s) < EMIT_FLOOR` with margin so the cadence stays designed rather than inference-bound.
- The idle path matters more once prose beats exist; 20s makes a thinking-and-writing session refresh visibly.

**Implications:**
- The `local_model.rs` assert against `EMIT_FLOOR` still holds; no ladder edit.
- These are starting values; `just model-stats` turnaround data is the standing tuning input.

#### [P06] The digest is a compressed transcript (DECIDED) {#p06-compressed-transcript}

**Decision:** Activity lines interleave in arrival order — prose, tool, and shell lines in one stream — under the existing two activity headings; the prompt section becomes the session's first prompt plus its most recent ones.

**Rationale:**
- The pulse summarizes the *transcript* (user direction); a digest sectioned by line *kind* would re-impose the toolbelt framing this plan removes.
- The first prompt is the standing goal and the recent prompts are the live direction; the middle prompts are the least informative slice and currently outvote the subject.

**Implications:**
- `compose_digest`'s three-section shape and headings survive unchanged; only the line vocabulary and budgets move.
- Background is clipped at compose time so a long session cannot outvote its own present (Spec S05).

#### [P07] Prompts are read incrementally, off-thread, with the first prompt pinned (DECIDED) {#p07-incremental-prompts}

**Decision:** A per-session `PromptCache` holds a byte offset, the pinned first prompt, and a bounded deque of recent prompts; each tick stats the file, reads only appended bytes via `spawn_blocking`, and resets only if the file shrank.

**Rationale:**
- The full-file `read_to_string` + parse of a 51MB JSONL inline in the async loop is the plan's Gap E — a glaring hole, and the faster clock makes it worse.
- The first prompt never changes, so pinning it makes the Gap-D prompt shape (first + recent) free.

**Implications:**
- The parse offset only advances past complete lines (the JSONL's last line may be mid-write).
- `scribe.rs`'s per-line prompt-extraction logic is factored into a shared helper so the batch function and the incremental reader cannot drift.

#### [P08] The submission is a beat, tapped from CODE_INPUT (DECIDED) {#p08-submission-beat}

**Decision:** The overview learns of a live user submission from the CODE_INPUT wire itself — a relay in `main.rs` teed between the router's input sink and the supervisor — not from any CODE_OUTPUT frame and not from the JSONL prompt cache.

**Rationale:**
- The live path emits **no** `add_user_message` on CODE_OUTPUT: that frame exists only on replay, the mid-turn snapshot, and the never-drop synthetic path; the steady-state live turn sends a uuid-only `prompt_anchor` (see #submission-wire). There is nothing to allowlist.
- Waiting for the JSONL cache to notice the new prompt would couple the ask to identity resolution and to the emit path's own schedule — the two dependencies the ask exists to jump.
- CODE_INPUT frames the overview sees are already authorized (the router's P5 cross-check runs before the sink) and are inherently live — replay and reconnect never ride CODE_INPUT, so the tap needs no mute set and no snapshot dedup.

**Implications:**
- A new `SessionOverviewConfig.submission_tx: broadcast::Sender<Frame>` and a third wire arm in the `select!` — exactly the growth path [P01] promised.
- Only `type == "user_message"` frames become beats; interrupts, approvals, mode changes, and every other CODE_INPUT verb are ignored.
- The `$` route already has its human-act wire: `exchange_started` (Step 3). No new shell plumbing.

#### [P09] A human act re-aims the pulse: force-fire at the next tick (DECIDED) {#p09-human-act-refire}

**Decision:** A live user submission and a `$` `exchange_started` each arm a per-session `fire_asap` flag; the tick sweep treats an armed session as due, bypassing the floor, the burst threshold, and the idle period. The committed tick clears the flag.

**Rationale:**
- The floor exists to stop re-summarize twitching on *streaming* evidence. A human act is not streaming evidence — it is rare, deliberate, and the single strongest signal that the current headline is stale. Human acts are bounded by typing speed; one inference per act is a cost worth paying for a pulse that answers the person.
- The proper-coast failure is exactly this gap: the cadence had no way to distinguish "more of the same turn" from "the subject just changed."

**Implications:**
- `Gates` still apply: a tenant switch, PULSE off, or model back-off silences a forced fire like any other.
- The digest-unchanged and headline-unchanged dedupes still guard the wire — a forced fire that would repeat the standing line emits nothing.
- The `SUMMARIZE_TIMEOUT < EMIT_FLOOR` ladder assert is untouched; the floor still paces every non-forced emit.

#### [P10] "Right now" is turn-relative: the ask resets the recency boundary (DECIDED) {#p10-turn-relative-recency}

**Decision:** The same human acts that arm `fire_asap` also zero `activity_since_emit`, so the digest's "What it is doing right now:" section starts empty at the ask and fills with the new turn's activity only. The newest ask itself rides the digest as the last line of the prompt section — the current directive.

**Rationale:**
- With sparse emits, an emit-relative recency window spans the whole previous turn; the first emit after a new prompt then truthfully summarizes "right now" as the old work — the observed proper-coast defect.
- The digest heading count is capped at three (#constraints), so the current directive cannot get a fourth section; newest-last in the existing prompt section plus an empty right-now is the strongest available signal that the old activity is background.

**Implications:**
- Ordering matters for the `$` route: reset the boundary first, then record the `exchange_started` beat, so the command itself is the first "right now" line.
- A submission records an `Asked` counter beat (no activity line — the prompt is not activity) and stores the ask text as `pending_ask`, deduped against the prompt cache once the JSONL catches up (Spec S07).

---

### Deep Dives {#deep-dives}

#### The three chokepoints, named {#chokepoints}

The tool-only behavior is enforced at three stacked points, and only two of them are wrong:

1. `forwardable_session` (`feeds/pulse.rs`) — the allowlist **passes** `assistant_text`; this gate is correct and untouched.
2. `session_beat` (`feeds/session_overview.rs`) — drops `assistant_text` one line after the allowlist admitted it. Widened by Step 1/2.
3. `SessionState::record` — only `Tool` beats contribute text. Widened by Step 1.

The shell route bypasses all three: it is a different broadcast entirely. Step 3 adds the subscription rather than routing shell frames through the CODE_OUTPUT tap — the one-way doctrine holds for both wires independently.

#### Live `assistant_text` semantics {#assistant-text-wire}

The critical wire fact (verified in `tugcode/src/session.ts`): live streaming emits `assistant_text { is_partial: true, text: <fragment> }` per delta, keyed `(msg_id, block_index)`, and **never** emits a terminal `is_partial: false` frame when a block completes. Terminal frames exist on exactly three paths: synthetic messages (slash-command output), replay, and the reconnect consolidated snapshot. Replay frames are already muted by the overview's bracket handling (`forwardable_session`'s `replay_started`/`replay_complete`); the reconnect snapshot is live and unmuted, which is why Spec S02's keyed dedup is load-bearing, not defensive.

`content_block_start` is not on `PULSE_FORWARD_ALLOWLIST`, so block boundaries are not directly observable; finalization is inferred (new key seen, or `turn_complete`). This is fine because [P02] beats at the head threshold anyway — finalization only matters for blocks shorter than the clip.

#### Why the shell subscription is cheap {#shell-subscription}

`SessionScopedFeed` (`feeds/session_scoped.rs`) exposes `subscribe()` and `sender()`; `shell_output_feed` is in scope at the overview wiring site in `main.rs` (the config block sits just above `register_session_feed(&shell_output_feed)`). The dispatcher's `emit` publishes through `SessionScopedFeed::publish`, which splices `tug_session_id` into the payload — so shell frames route by the same field as CODE_OUTPUT frames. `exchange_complete` carries the full command `output`; the overview parses only `type`, `command`, and `exit_code` and never retains the payload.

#### The submission wire {#submission-wire}

Where the user's message actually travels (verified in `tugproto/src/inbound.ts`, `tugdeck/src/protocol.ts`, `tugcode/src/types.ts`, and `tugrust/crates/tugcast/src/main.rs`):

- The deck encodes `{ tug_session_id, type: "user_message", content: ContentBlock[] }` (`encodeCodeInputPayload`) and sends it on **CODE_INPUT**. `content` is an Anthropic content-block array; the text lives in `{ type: "text", text }` blocks (image blocks may interleave).
- tugcast's router authorizes the frame (P5 session-ownership cross-check in `authorize_and_claim_input`) and hands it to the input sink registered in `main.rs`: `feed_router.register_input(FeedId::CODE_INPUT, code_input_tx)`, consumed by `supervisor.dispatcher_task(code_input_rx)`.
- **CODE_OUTPUT never carries the live submission.** `add_user_message` is emitted only by the JSONL replay translator, the mid-turn consolidated snapshot, and the never-drop synthetic path; the steady-state live turn emits `prompt_anchor { promptUuid }` — a uuid with no text (documented at the `AddUserMessage` / `PromptAnchor` types in `tugcode/src/types.ts`). An allowlist entry cannot fix Gap [P08]; the tap must sit on the input side.
- The tap seam: `main.rs` interposes a relay mpsc — the router's registered sink becomes the relay's sender; a small task forwards every frame verbatim to the supervisor's original `code_input_tx` **and** publishes it on a `broadcast::Sender<Frame>` for the overview. The supervisor sees byte-identical traffic; the overview stays one-way (it taps a broadcast, backpressures nothing — a lagged overview subscriber drops frames, never delays the supervisor forward).

#### What the prior plan's instrumentation buys this one {#measurement-inheritance}

Every step here lands against a measurement surface that already exists: `session overview: summarized` logs `elapsed_ms`, `raw`, `headline`, and the three register-report flags; `just model-stats <instance>` computes headline change rate and turnaround percentiles from accumulated logs; `just model-liveness` is the smoke check; `just model-eval` scores register quality against the corpus. The 44% (87/199) change-rate baseline is on file from `release-main`. This plan adds no new instrumentation — it is the consumer the instrumentation was built for.

---

### Specification {#specification}

**Spec S01: Activity line vocabulary** {#s01-activity-lines}

One interleaved activity stream per session, each line from one beat, in arrival order:

| Beat | Source frame | Digest line | Notes |
|------|-------------|-------------|-------|
| `Tool` | CODE_OUTPUT `tool_use` | `Name(target)` | unchanged from today (`tool_line`) |
| `Said` | CODE_OUTPUT `assistant_text` (accumulated) | `said: <head>` | head = first sentence or `MAX_SAID_CHARS`, whichever first; single line, whitespace-collapsed |
| `Shell` | SHELL_OUTPUT `exchange_started` | `$ <command>` | command clipped to `MAX_TARGET_CHARS` (60), matching tool targets |
| `Shell` | SHELL_OUTPUT `exchange_complete`, `exit_code != 0` | `$ <command> → exit N` | — |
| `Shell` | SHELL_OUTPUT `exchange_complete`, `exit_code == 0` | — | counter advance only; `Shell`'s line is an `Option<String>` and this is its `None` case — **never** `SessionBeat::Turn`, which carries prose side effects |
| `Turn` | CODE_OUTPUT `turn_complete` **or** `turn_cancelled` | — | counter advance; finalizes any open prose block and clears `beaten` — these side effects key off CODE_OUTPUT turn frames **only**, never off shell beats |

`MAX_SAID_CHARS` starts at 100 ([Q01] tunes it). Sentence boundary = the first `.`, `!`, or `?` followed by whitespace/end, at index ≥ 20 (so "e.g." bait doesn't produce stub lines; a simple threshold, not a sentence parser).

**Spec S02: Prose accumulation state machine** {#s02-prose-accumulation}

Per session, alongside the activity deque:

- `open: Option<ProseBlock { key: (String, u64), text: String }>` — at most one open block; `beaten: HashSet<(String, u64)>` bounded by clearing on `turn_complete`.
- On `assistant_text { msg_id, block_index, is_partial: true, text }`:
  - key = `(msg_id, block_index)`; if key ∈ `beaten`, drop.
  - If `open` holds a *different* key: finalize it (emit `Said` if non-empty and not beaten), then open the new key.
  - Append fragment to `open.text` **only up to** `MAX_SAID_CHARS + slack` (no unbounded buffering); when the head first crosses the threshold (sentence or cap), emit the `Said` beat immediately, add key to `beaten`, keep the block open only as a key marker.
- On `assistant_text { is_partial: false }` (reconnect snapshot / synthetic): if key ∈ `beaten`, drop; else treat `text` as the whole block and beat once from its head.
- On `turn_complete` **or** `turn_cancelled`: finalize any open block, then clear `beaten` (msg ids never recur across turns) and record the `Turn` beat. `turn_cancelled` matters: a cancelled turn's trailing prose — what the session was saying when the user hit Escape — is often the most informative line it produced, and without this rule it never beats and its state leaks until the next turn's traffic. (`turn_cancelled` is already on `PULSE_FORWARD_ALLOWLIST`; today `session_beat` returns `None` for it.)
- Finalization and `beaten`-clearing are triggered **only** by CODE_OUTPUT turn frames (`turn_complete`/`turn_cancelled`). A zero-exit `exchange_complete` is a `Shell` beat with no line (Spec S01) — a shell command settling mid-prose-stream must not finalize an open assistant block or clear the dedup set while the turn is still live.

**Spec S03: Cadence semantics under the clock** {#s03-cadence}

- The `select!` gains `_ = tick.tick()` (interval 2s). The frame arm only records beats; the tick arm sweeps every `SessionState` and, for each where `Gates::allow()` and `Cadence::fires(new_beats, now - last_emit)`, runs the emit path (commit counters → digest → dedupe → summarize → register → PULSE).
- `Cadence` fields become `{ burst_beats: 8, idle_period: 20s, floor: 8s }`; `fires` keeps its shape: `new > 0 && since >= floor && (new >= burst || since >= idle)`. With prose and shell counting, `new == 0` now truly means "nothing happened."
- Back-off, gates, digest dedupe (`last_digest`), and headline dedupe (`last_headline`) are unchanged.
- Sweep order is map order; ties serialize through the one shared model (accepted, Risk table).

**Spec S04: PromptCache** {#s04-prompt-cache}

```rust
struct PromptCache {
    offset: u64,                    // bytes parsed so far (always at a line boundary)
    first: Option<String>,          // the session's first prompt, pinned
    recent: VecDeque<String>,       // last MAX_RECENT_PROMPTS prompts
}
```

- On each due tick: `std::fs::metadata(&jsonl)`; if `len == offset`, cache is current. If `len < offset` (rewritten file), reset the cache and re-read from 0. Else read `[offset, len)` in `spawn_blocking`, parse complete lines only, advance `offset` to the last `\n` consumed.
- Line parsing reuses the exact filter chain of `session_prompts_since` (`type == "user"`, `isMeta`/`isCompactSummary`/`permissionMode` exclusions, `user_submission_opens_turn`, `submission_text`), factored into a shared per-line helper in `scribe.rs` so the two readers cannot drift.
- Digest prompt set = `first` + up to `MAX_RECENT_PROMPTS` from `recent`, deduped when the first prompt is still among the recent ones.
- An unresolvable identity still costs only the prompts, never the tick.

**Spec S05: Digest layout and starting budgets** {#s05-digest-layout}

`compose_digest(prompts, activity, recent_count)` keeps its three sections and exact headings ("What the user asked for:" / "What the session has been doing:" / "What it is doing right now:"), empty sections omitted, both-empty → `None`. What changes:

| Budget | Today | Starting candidate ([Q01]) |
|--------|-------|---------------------------|
| activity deque cap (`MAX_TOOL_LINES` → `MAX_ACTIVITY_LINES`) | 40 | 24 |
| background lines in the digest (compose-time clip, newest kept) | up to 32 | 12 |
| prompts | last 10 × 240 chars | first + 2 recent × 240 chars |
| prose line clip (`MAX_SAID_CHARS`) | — | 100 |

The compose-time background clip is new: `tools[..split]` becomes the *last* 12 of the background slice, so a long session's ancient history drops out of the model's input entirely while the deque keeps enough for the next split.

**Spec S06: The submission tap and the Asked event** {#s06-submission-tap}

- `main.rs` relay: construct `(relay_tx, relay_rx) = mpsc::channel(<same capacity as code_input_tx's channel>)` and a `broadcast::channel::<Frame>(64)` submission bus; register `relay_tx` as the CODE_INPUT input sink in place of `code_input_tx`; spawn a task that loops `relay_rx.recv()` → `broadcast.send(frame.clone())` (ignore send errors — zero receivers is normal before the overview starts) → `code_input_tx.send(frame).await` (forward failure ends the relay exactly as the sink closing would). Forward *after* publish so the overview's clock never trails the supervisor's by more than the broadcast hop.
- `SessionOverviewConfig.submission_tx: broadcast::Sender<Frame>` wired from the relay's broadcast sender; the task subscribes and adds a third wire arm to the `select!` (lagged → warn-and-continue; closed → return, mirroring the other arms).
- Frame handling: parse the payload JSON; require `tug_session_id` (string) and `type == "user_message"`; everything else → ignore. Extract the ask text through the prompt cache's own extraction — `external_sessions::submission_text` (text blocks concatenated), trimmed, then the cache's own clip (`chars().take(MAX_PROMPT_CHARS)`, no ellipsis) — so the dedup in Spec S07 is exact string equality against what `prompt_from_jsonl_line` later yields for the same submission. An image-only submission (no text) still counts as a human act (beat + re-aim) with no pending-ask line.
- `SessionBeat::Asked(Option<String>)`: a counter beat — never an activity line; the prompt is not activity, it is direction. `record` treats it like `Turn` (counter only); the state handler additionally stores the text as `pending_ask` and performs the [P10] reset + [P09] arm.
- Prose-state safety: an ask does **not** finalize an open prose block and does not clear `beaten` — those side effects stay keyed to CODE_OUTPUT turn frames only (Spec S02). A submission racing a still-streaming cancelled turn leaves the accumulation state to the `turn_cancelled` frame that follows on the output wire.

**Spec S07: Re-aim semantics — force-fire, recency reset, and the pending ask** {#s07-reaim}

Per session, alongside the Spec S02 state:

- `fire_asap: bool` — armed by `Asked` and by `Shell` beats born from `exchange_started` (the two human acts); cleared by the committed tick, whatever the emit outcome past that point.
- The tick sweep's due test becomes: `fire_asap && new_beats > 0`, **or** the unchanged `Cadence::fires(new_beats, since_last_emit)`. Gates short-circuit the whole sweep exactly as today; a forced fire is never exempt from tenant/PULSE/back-off.
- The [P10] reset: on `Asked` and on `exchange_started`, set `activity_since_emit = 0` *before* recording the beat — so the shell command's own line is the first "right now" entry and a submission leaves "right now" empty until the response streams.
- `pending_ask: Option<String>` — the newest submission's clipped text. Digest prompt set = `PromptCache::digest_prompts()` + `pending_ask` appended last, skipped when it already equals the cache's newest recent entry (the JSONL caught up) or the pinned first (a young session's opening ask). Cleared when the equality check first passes — from then on the cache carries it.
- A committed tick that fails downstream (no requester, summarize error) must not swallow the standing digest: `last_digest` is recorded only after a successful summarize, so the same digest re-tries once the model returns. (Today `last_digest` is set before the requester check — a model briefly absent at the first sweep permanently eats that digest; Step 9 fixes this as part of the re-aim work because forced fires make the window live.)

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| — | no new files; all changes land in existing modules |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `SessionBeat::{Said, Shell}` | enum variants | `tugrust/crates/tugcast/src/feeds/session_overview.rs` | `Said(String)`, `Shell(Option<String>)` — line pre-formatted at mapping time; `Shell(None)` is the zero-exit completion (counter only, no prose side effects) |
| `session_beat` | fn (modify) | same | stays CODE_OUTPUT-only; `turn_cancelled` maps to `Turn` alongside `turn_complete`; `assistant_text` returns a new `BeatInput::Prose{..}` — see `code_output_event` note in #step-2 |
| `shell_beat` | fn (new) | same | SHELL_OUTPUT payload → `Option<SessionBeat>` per Spec S01; never returns `Turn` |
| `ProseBlock`, prose fields on `SessionState` | struct/fields (new) | same | Spec S02 state |
| `SessionState::activity` | field (rename) | same | was `tools`; interleaved lines |
| `Cadence` | struct (modify) | same | `burst_beats`, lowered defaults ([P05]) |
| `session_overview_task` | fn (modify) | same | shell `select!` arm + tick arm; per-frame cadence check removed |
| `compose_digest` | fn (modify) | same | background compose-time clip (Spec S05) |
| `SessionOverviewConfig::shell_tx` | field (new) | same | `broadcast::Sender<Frame>`; wired from `shell_output_feed.sender()` in `main.rs` |
| `prompt_from_jsonl_line` | fn (new, factored) | `tugrust/crates/tugcast/src/scribe.rs` | shared per-line extraction; `session_prompts_since` re-expressed over it |
| `PromptCache` | struct (new) | `session_overview.rs` (or `scribe.rs` if the read logic reads better there) | Spec S04 |
| `MAX_ACTIVITY_LINES`, `MAX_SAID_CHARS`, `MAX_RECENT_PROMPTS`, background clip const | consts | `session_overview.rs` | Spec S05 values, finalized by [Q01] |
| `SessionBeat::Asked` | enum variant | `session_overview.rs` | `Asked(Option<String>)` — counter beat, never an activity line; the clipped ask text or `None` for an image-only submission (Spec S06) |
| `submission_beat` | fn (new) | same | CODE_INPUT payload → `Option<(String, SessionBeat)>`: the `tug_session_id` plus an `Asked` for `type == "user_message"`, `None` for every other verb; text = `content[]` text blocks joined, trimmed, clipped to `MAX_PROMPT_CHARS` |
| `SessionState::{fire_asap, pending_ask}` | fields (new) | same | Spec S07 re-aim state |
| `SessionOverviewConfig::submission_tx` | field (new) | same | `broadcast::Sender<Frame>`; wired from the `main.rs` CODE_INPUT relay |
| CODE_INPUT relay task | wiring (new) | `tugrust/crates/tugcast/src/main.rs` | interposes on `register_input(FeedId::CODE_INPUT, …)`: publish to the submission broadcast, then forward verbatim to the supervisor's original `code_input_tx` (#submission-wire) |
| `emit_overview` | fn (modify) | `session_overview.rs` | records `last_digest` only after a successful summarize (Spec S07's retry fix); clears `fire_asap` at the committed tick |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | beat mapping, prose accumulation, cadence predicate, compose clipping, cache offset math | every pure function this plan touches |
| **Integration (paused clock)** | end-to-end emitter behavior over both broadcasts with `#[tokio::test(start_paused = true)]` | the success-criteria scenarios (prose-only, shell-only, trailing-stretch) |
| **Golden / Contract** | `corpus_digests_are_what_compose_digest_produces` pin; regenerated corpus | Step 6 |
| **Model eval** | `just model-eval` register scoring against the regenerated corpus | Step 6 gate |

#### What stays out of tests {#test-non-goals}

- New app-tests — the PULSE wire contract is unchanged, so `at0282-pulse-two-level.test.ts` already covers the deck path; a new app-test would re-test tugcast logic the paused-clock tests own. (App-test runs stay selective per repo policy.)
- Live-model latency assertions in Rust tests — turnaround is telemetry (`just model-stats`), not a unit-testable property.
- Fake-DOM / mock-store tests — banned repo-wide; nothing here is frontend anyway.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Widen the beat vocabulary and interleave the activity stream | done | bbf6af968 |
| #step-2 | Prose beats from live assistant_text deltas | done | c880ae144 |
| #step-3 | Shell beats: subscribe the overview to SHELL_OUTPUT | done | 7d99491b0 |
| #step-4 | Clock-driven emitter and lowered cadence | done | b1be9b514 |
| #step-5 | Incremental prompt cache | done | 9e9f84937 |
| #step-6 | Digest rebalance, corpus regeneration, eval gate | done | d34e35a8b |
| #step-7 | Integration checkpoint — live transcript following | done | verification only |
| #step-8 | The submission tap: CODE_INPUT reaches the overview | done | 43e02f5c2 |
| #step-9 | Human acts re-aim the pulse | done | 1b0c08fbd |
| #step-10 | Ask-shape eval and live re-vetting | done | b4b1a3e00 |

#### Step 1: Widen the beat vocabulary and interleave the activity stream {#step-1}

**Commit:** `tugcast(session-overview): widen SessionBeat to the transcript vocabulary`

**References:** [P01] enum is the bus, [P06] compressed transcript, Spec S01, (#chokepoints, #s01-activity-lines)

**Artifacts:**
- `SessionBeat::{Tool, Said, Shell, Turn}` with content-bearing variants carrying their pre-formatted line (`Shell` carries `Option<String>`; its `None` case is the zero-exit completion, Spec S01).
- `SessionState.tools` → `SessionState.activity` (interleaved deque, `MAX_ACTIVITY_LINES`); `tools_since_emit` → `activity_since_emit`.
- `SessionState::record` appends the line for any content-bearing beat; `Turn` stays counter-only.

**Tasks:**
- [ ] Add the variants and rename the state fields; update `record`, the emit path's `tools`/`recent_tools` locals, and every test that constructs beats.
- [ ] Keep `session_beat`'s output for `tool_use`/`turn_complete` byte-identical (`tool_line` untouched) — this step changes the *container*, not the producers.
- [ ] Update the module header docblock: the overview follows the transcript (prose + tools + shell), not tool telemetry.

**Tests:**
- [ ] `record` interleaves `Tool`/`Said`/`Shell` lines in arrival order and evicts oldest at `MAX_ACTIVITY_LINES`.
- [ ] `Turn` advances counters without a line.
- [ ] Existing digest/cadence tests still pass under the renamed fields.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_overview`
- [ ] `cd tugrust && cargo build -p tugcast` (warnings are errors)

---

#### Step 2: Prose beats from live assistant_text deltas {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(session-overview): assistant prose is a first-class beat`

**References:** [P02] prose beats, Spec S01, Spec S02, Risk R01, (#assistant-text-wire)

**Artifacts:**
- Prose accumulation state on `SessionState` (`ProseBlock`, `beaten` set) per Spec S02.
- `assistant_text` handling in the frame arm: accumulate, beat at head threshold, keyed dedup, finalize on new key / `turn_complete`.
- `said:` line formatting (sentence-or-cap head extraction, whitespace collapse).

**Tasks:**
- [ ] Extend the frame-arm dispatch: `session_beat` (or a widened successor) surfaces prose fragments with `(msg_id, block_index, is_partial, text)` so accumulation lives on `SessionState`, not in the parser.
- [ ] Implement the head-extraction helper (first sentence at index ≥ 20, else `MAX_SAID_CHARS` cap) as a pure `pub fn` for direct testing.
- [ ] Handle `is_partial: false` frames per Spec S02 (whole-block text, beaten-key drop) — this is the reconnect-snapshot dedup.
- [ ] Clear `beaten` and finalize open blocks on `turn_complete` **and** `turn_cancelled` (map `turn_cancelled` to `Turn` in `session_beat`); the trigger is CODE_OUTPUT turn frames only, never shell beats.

**Tests:**
- [ ] Delta fragments accumulate and beat exactly once at the sentence boundary; further deltas for the key are dropped.
- [ ] A short block (never crossing the threshold) beats at finalization via a new key, via `turn_complete`, and via `turn_cancelled`.
- [ ] A `Shell(None)` beat mid-stream leaves an open prose block and the `beaten` set untouched.
- [ ] An `is_partial: false` snapshot for a beaten key produces no second beat; for an unseen key produces exactly one.
- [ ] Accumulation buffer never exceeds cap + slack (bounded even for a 10k-char block).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_overview`

---

#### Step 3: Shell beats — subscribe the overview to SHELL_OUTPUT {#step-3}

**Depends on:** #step-1

**Commit:** `tugcast(session-overview): the $ route reaches the pulse`

**References:** [P03] shell beats, Spec S01, (#shell-subscription)

**Artifacts:**
- `SessionOverviewConfig.shell_tx: broadcast::Sender<Frame>`; a `shell_rx` subscription and `select!` arm in `session_overview_task`.
- `shell_beat(payload) -> Option<SessionBeat>`: `exchange_started` → `Shell(Some("$ cmd"))`; `exchange_complete` → `Shell(Some("$ cmd → exit N"))` on nonzero exit, `Shell(None)` on zero exit; everything else `None`. Never returns `Turn` ([P03], Spec S02).
- `main.rs` wiring: `shell_tx: shell_output_feed.sender()` in the overview config block.

**Tasks:**
- [ ] Add the config field, subscription, and arm; shell frames route by the spliced `tug_session_id` and need no mute set (see #assumptions).
- [ ] Implement `shell_beat` parsing only `type`/`command`/`exit_code`; clip commands to `MAX_TARGET_CHARS`.
- [ ] Lagged/closed shell receiver mirrors the code receiver's handling (warn-and-continue / return).

**Tests:**
- [ ] `shell_beat` mapping table: started, complete-zero, complete-nonzero, `shell_state`, `path_commands`, missing fields.
- [ ] Paused-clock integration: a session publishing only shell frames reaches the cadence and emits an overview (extend the existing `TestHarness` with a shell sender).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_overview`
- [ ] `cd tugrust && cargo build -p tugcast`

---

#### Step 4: Clock-driven emitter and lowered cadence {#step-4}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `tugcast(session-overview): the emitter runs on a clock`

**References:** [P04] clock-driven, [P05] cadence numbers, Spec S03, (#s03-cadence)

**Artifacts:**
- Tick arm (2s interval) in `session_overview_task`; per-session cadence sweep; emit path moved out of the frame arm.
- `Cadence { burst_beats: 8, idle_period: 20s, floor: 8s }`; `EMIT_FLOOR` = 8s (still `pub`, ladder assert in `local_model.rs` still true).

**Tasks:**
- [ ] Add `tokio::time::interval` with `MissedTickBehavior::Delay`; move the committed-tick path (counter reset → prompts → digest → dedupe → summarize → register → PULSE) into a sweep over due sessions.
- [ ] Remove the per-frame cadence evaluation; the frame arm ends at `state.record(beat)`.
- [ ] Update the cadence constants and every doc comment that states the old numbers; verify the `local_model.rs` `SUMMARIZE_TIMEOUT < EMIT_FLOOR` assertion still compiles true.
- [ ] Keep the sweep resilient: one session's summarize failure back-offs globally exactly as today; the sweep continues next tick.

**Tests:**
- [ ] Paused clock: prose-only session (only `assistant_text` deltas) emits within `idle_period` — the frozen-headline freeze case, now impossible.
- [ ] Paused clock: a burst then silence — the tick arm fires the emit with zero trailing frames (the "final stretch" case).
- [ ] Paused clock: no beats at all → no emit ever (the `new == 0` guard).
- [ ] `Cadence::fires` unit table at the new numbers.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 5: Incremental prompt cache {#step-5}

**Depends on:** #step-4

**Commit:** `tugcast(session-overview): incremental prompt reads with a pinned first prompt`

**References:** [P07] incremental prompts, Spec S04, (#s04-prompt-cache)

**Artifacts:**
- `PromptCache` per Spec S04, held per session by the overview task; `prompt_from_jsonl_line` factored in `scribe.rs` with `session_prompts_since` re-expressed over it.
- The emit path reads prompts via the cache in `spawn_blocking`; the `session_prompts_since(&jsonl, 0, …)` full read is gone from the loop.

**Tasks:**
- [ ] Factor the per-line filter chain (`type == "user"`, meta/compact/permission exclusions, `user_submission_opens_turn`, `submission_text`, char clip) into `prompt_from_jsonl_line`; keep `session_prompts_since`'s behavior byte-identical (its existing tests are the guard).
- [ ] Implement the cache: stat → same-length short-circuit → shrink reset → append read from `offset` parsing complete lines only → pin `first`, rotate `recent`.
- [ ] Move the read off the async thread (`tokio::task::spawn_blocking`); an I/O error costs the prompts, never the tick.

**Tests:**
- [ ] Temp-file test: write N lines, read; append M lines, read again — second read consumed only the appended bytes (offset assertion) and `first` is unchanged.
- [ ] Partial trailing line (no `\n`) is not consumed and parses correctly once completed by a later append.
- [ ] Shrunk file resets and re-reads; `first` re-pins.
- [ ] `session_prompts_since` regression tests still green over the factored helper.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast scribe session_overview`

---

#### Step 6: Digest rebalance, corpus regeneration, eval gate {#step-6}

**Depends on:** #step-5

**Commit:** `tugcast(session-overview): the digest reads as a compressed transcript`

**References:** [P06] compressed transcript, Spec S05, [Q01], [Q02], Risk R02, (#s05-digest-layout, #measurement-inheritance)

**Artifacts:**
- Compose-time background clip and the Spec S05 budgets; digest prompt set = pinned first + recent.
- Regenerated `tests/model-eval/corpus/*.digest.txt` (via `TUG_REGENERATE_DIGESTS=1 cargo nextest run corpus_digests`) after corpus JSONs gain representative `said:` and `$` lines in their `tools` arrays (the corpus format itself is unchanged — lines are just strings).
- A recorded eval result in the dash round summary settling [Q01] (final budget values) and [Q02] (prompt frozen or touched, with A/B evidence if touched).

**Tasks:**
- [ ] Implement the compose-time background clip (last 12 of the background slice) and the prompt-set change; update `compose_digest` doc comments.
- [ ] Extend 3–4 corpus entries with interleaved `said:`/`$` lines mirroring real transcripts (match existing JSON formatting: indent=1, no trailing newline); add `investigate`-style verbs to `verbs.txt` only if the model earns them.
- [ ] Regenerate frozen digests; run `just model-eval <debug-instance>` at the candidate budgets; iterate budgets if the register regresses; only touch `LocalModelPrompts.summarize` under [Q02]'s A/B discipline.
- [ ] Record final constants and eval scores in the round summary.

**Tests:**
- [ ] `compose_digest` unit tests for the background clip, first+recent prompt layout, and section-omission invariants (empty sections still omitted; both-empty still `None`).
- [ ] `corpus_digests_are_what_compose_digest_produces` green against the regenerated corpus.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `just model-eval <debug-instance>` — register pass rate ≥ the pre-plan 12/12 on the regenerated corpus

---

#### Step 7: Integration checkpoint — live transcript following {#step-7}

**Depends on:** #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #measurement-inheritance), [P03], [P04]

**Tasks:**
- [ ] `just app-debug` from the worktree; confirm the instance via `just instances`.
- [ ] In the live Session card: run a `$` command and confirm a `$`-line-bearing digest and an overview emit in the logs (`just logs-debug`, `session overview: summarized`); hold a prose-only exchange and confirm an emit with a `said:` line and no `tool_use` in the window; let a session go quiet after a burst and confirm the trailing emit.
- [ ] `just model-liveness <debug-instance>` passes; `just model-stats <debug-instance>` after a real working stretch, recorded against the 44% baseline in the round summary.

**Tests:**
- [ ] `just app-test tests/app-test/at0282-pulse-two-level.test.ts` (regression; wire contract unchanged) plus whatever `just app-test-changed` selects for the diff.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (full workspace)
- [ ] `just app-test-changed` verdict PASS
- [ ] Live log evidence for the three scenarios above, quoted in the round summary

---

#### Step 8: The submission tap — CODE_INPUT reaches the overview {#step-8}

**Depends on:** #step-3

**Commit:** `tugcast(session-overview): the user's submission reaches the pulse`

**References:** [P08] submission beat, Spec S06, (#submission-wire)

**Artifacts:**
- The `main.rs` CODE_INPUT relay: publish to a new submission broadcast, then forward verbatim to the supervisor's `code_input_tx` (Spec S06's ordering — publish first). The supervisor's traffic is byte-identical before and after.
- `SessionOverviewConfig.submission_tx: broadcast::Sender<Frame>`; a `submission_rx` subscription and a third wire arm in `session_overview_task`'s `select!` (lagged → warn-and-continue, closed → return, mirroring the shell arm).
- `submission_beat(payload) -> Option<(String, SessionBeat)>`: `user_message` → the session id plus `Asked(Some(text))` / `Asked(None)` for image-only content; every other CODE_INPUT verb → `None`. Text extraction per Spec S06 (the prompt cache's own extraction and clip, so later JSONL reads spell the same ask identically).
- This step records the `Asked` beat as a plain counter beat only — the re-aim semantics (reset, force-fire, pending ask) are Step 9, so this step's behavior change is exactly "a submission advances the cadence."

**Tasks:**
- [ ] Interpose the relay in `main.rs` at the `register_input(FeedId::CODE_INPUT, …)` site; keep channel capacity equal to the original sink's so the relay adds a hop, not a buffer cliff.
- [ ] Add the config field, subscription, and `select!` arm; route by the payload's own `tug_session_id` (no splice needed — the deck encodes it).
- [ ] Implement `submission_beat`; wire the frame arm to `record` the beat (counter semantics, no activity line).

**Tests:**
- [ ] `submission_beat` mapping table: text submission, multi-block text+image, image-only, `interrupt`, `tool_approval`, missing `tug_session_id`, malformed JSON.
- [ ] Paused-clock integration: a session receiving only submission frames (no CODE_OUTPUT, no SHELL_OUTPUT) accumulates beats and emits once the cadence is met — the third wire is live end to end.
- [ ] A relay round-trip test at the tugcast layer: frames sent into the relayed sink arrive at the supervisor-side receiver unchanged and in order.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_overview`
- [ ] `cd tugrust && cargo build -p tugcast` (warnings are errors)

---

#### Step 9: Human acts re-aim the pulse {#step-9}

**Depends on:** #step-8

**Commit:** `tugcast(session-overview): a human act re-aims the pulse`

**References:** [P09] force-fire, [P10] turn-relative recency, Spec S07, Risk table (forced fires, stale background)

**Artifacts:**
- `SessionState.{fire_asap, pending_ask}` per Spec S07; `Asked` and `exchange_started`-born `Shell` beats arm `fire_asap` and zero `activity_since_emit` (reset before record, so the shell line is the first "right now" entry).
- The tick sweep's due test: `fire_asap && new_beats > 0` or the unchanged `Cadence::fires`; the committed tick clears `fire_asap`.
- Digest prompt set = cache prompts + `pending_ask` appended last, equality-deduped and cleared once the cache carries it (Spec S07).
- `last_digest` recorded only after a successful summarize — the unsummarized-digest retry fix (Spec S07's final bullet).
- Prose-state safety per Spec S06: an ask neither finalizes an open block nor clears `beaten`.

**Tasks:**
- [ ] Add the re-aim state and wire both human acts through it; keep the reset-then-record ordering.
- [ ] Extend the due test in the tick sweep; clear the flag in `emit_overview`'s committed-tick block.
- [ ] Append/dedupe `pending_ask` in the emit path's prompt assembly; clear on cache catch-up.
- [ ] Move the `last_digest` assignment after the summarize success arm; the failure arms leave it untouched.

**Tests:**
- [ ] Paused clock: mid-quiet-stretch submission → emit at the next tick, floor and idle both unexpired (the proper-coast fix, pinned).
- [x] Paused clock: full turn → emit → new submission → next digest's "right now" section is the fresh ask verbatim (sole line, digest ends on it — per the Step 10 amendment) and the old turn's lines sit in background; the ask is the last prompt line.
- [ ] Paused clock: `exchange_started` force-fires and its `$` line is the sole "right now" entry.
- [ ] `pending_ask` dedup: once the prompt cache's newest recent equals the ask, the digest carries it once; a young session's first ask never doubles against the pinned first prompt.
- [ ] An ask mid-prose-stream leaves `open` and `beaten` untouched (extends the Spec S02 suite).
- [ ] Summarize-failure retry: requester absent at the forced fire → same digest succeeds on the next sweep once the requester returns (the `last_digest` fix, pinned).
- [ ] Forced fire respects gates: with back-off active the armed session emits nothing, and because gates short-circuit the sweep *before* any tick commits, `fire_asap` survives and fires on the first allowed tick after the back-off expires.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 10: Ask-shape eval and live re-vetting {#step-10}

**Depends on:** #step-9

**Commit:** `tugcast(session-overview): ask-shape corpus entry and eval gate`

**References:** (#success-criteria, #measurement-inheritance), Risk R02, [Q02]

**Artifacts:**
- A corpus entry mirroring the ask shape (old turn's lines all background, no right-now section, prompts ending with a fresh directive on a different topic) — the model must headline the directive, not the background. Regenerated digests; `just model-eval` at parity, prompt still frozen unless [Q02]'s A/B discipline says otherwise.
- Live re-vetting of the proper-coast scenario on a rebuilt debug instance, with log evidence quoted in the round summary.

**Tasks:**
- [ ] Author the ask-shape corpus entry (match existing JSON formatting: indent=1, no trailing newline); `TUG_REGENERATE_DIGESTS=1 cargo nextest run corpus_digests`; `just model-eval <debug-instance>` — register at parity and the ask-shape entry headlined on the directive.
- [ ] `just app-debug` from the worktree; replay the proper-coast scenario live: two conversational asks on different topics in one session; confirm each ask's overview lands before its turn completes (`just logs-debug`, `session overview: summarized` timestamps against the JSONL's submission timestamps).
- [ ] Run a `$` command mid-session and confirm the re-aim emit within a tick or two of `exchange_started`.

**Tests:**
- [ ] `corpus_digests_are_what_compose_digest_produces` green against the regenerated corpus.
- [ ] `just app-test tests/app-test/at0282-pulse-two-level.test.ts` (wire contract still unchanged) plus whatever `just app-test-changed` selects.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (full workspace, modulo the known `external_sessions` flake)
- [ ] `just model-eval <debug-instance>` ≥ 12/12 with the new entry passing
- [ ] Live log evidence: submission timestamp → overview emit within one tick + inference, for both asks and the `$` command, quoted in the round summary

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A pulse that follows the transcript and is led by the human: prose, tool calls, shell commands, and the user's own submissions all feed the digest and the cadence; a human act re-aims the pulse at the next tick with a turn-relative "right now"; the emitter fires on a clock with lower floors; the prompt read is incremental; and the rebalanced digest is validated through model-eval before it ships.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Prose-only, shell-only, and trailing-stretch sessions all emit overviews (paused-clock tests + live log evidence).
- [ ] The emit loop performs no full-file JSONL reads (cache tests + code inspection: `session_prompts_since(_, 0, …)` absent from the loop).
- [ ] `just model-eval` register at parity or better on the regenerated compressed-transcript corpus.
- [ ] `EMIT_FLOOR` = 8s with the timeout-ladder assert still true; `at0282` green.
- [ ] Live `just model-stats` change-rate reading recorded against the 44% baseline.
- [ ] A live submission's overview lands before its turn completes, aimed at the new ask; the emit after a new ask carries no stale "right now" — the section holds the fresh ask itself (paused-clock tests + Step 10 live log evidence).

**Acceptance tests:**
- [ ] `cd tugrust && cargo nextest run` — full workspace green (modulo the known pre-existing `external_sessions` reference-session flake, which reads this conversation's own live transcript).
- [ ] `just app-test-changed` — VERDICT: PASS.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Ask-aim quality on meta-phrased asks: the Step 10 probes showed the 100M model aims correctly at a plain directive ("chase the typing lag in the composer") even with the old turn's background present, but a conversational preamble ("now switch topics entirely: what is a monad…") makes it discount the whole line and headline the background or the first prompt instead — the same digest with the preamble stripped aims correctly. Stripping preambles is fragile NLP; the honest fixes are a bigger model or prompt A/B under [Q02]. Probe evidence in the Step 10 round summary.
- [ ] Shell-command classification quality: harvest real commands + verdicts from the accumulated `task=classify` log lines into a labeled corpus and add a classify register to model-eval — feeds on this plan's shell plumbing.
- [ ] Cadence tuning from a week of `just model-stats` data (the reason the analyzer exists); revisit `BURST_FRAMES` and the 2s tick if turnaround data argues.
- [ ] A third beat wire (e.g. composer bang-command routings) if the transcript vocabulary grows — the enum-is-the-bus decision keeps it a `select!` arm away.
- [ ] The prior plan's deferred items: dev-panel liveness numbers, `NSLog` → `TugLog` migration, the 56-char headline-budget question.

| Checkpoint | Verification |
|------------|--------------|
| Transcript vocabulary lands | `cargo nextest run -p tugcast session_overview` |
| Clock-driven emitter | paused-clock trailing-stretch test |
| Incremental prompts | cache offset tests |
| Digest quality | `just model-eval` ≥ 12/12 on regenerated corpus |
| Live behavior | Step 7 log evidence + `just model-stats` |
