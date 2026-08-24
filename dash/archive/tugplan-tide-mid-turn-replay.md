<!-- tugplan-skeleton v2 -->

## Tide Transcript — Mid-turn Replay (Investigation + Design) {#tide-mid-turn-replay}

**Purpose:** Make the mid-turn reload case work *robustly*. After a user reloads (HMR, Cmd-R, cold-boot) while a turn is in flight, the Tide card should fetch the conversation history and connect to the live continuation of the in-flight turn — without losing a single event in any race or drop window. Today this case is broken; one prior design attempt was reverted because it was built on speculation rather than observation. This plan opens with an automated investigation phase, then designs from observed reality.

**Design goal stated by the user:**

> "The front end is not doing much work. The reducer's existing msg_id-keyed accumulation handles everything. Claude Code keeps ticking. Tugcast keeps ticking. The card just observes."

> "We must NEVER drop a message on the floor — one way or another."

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | shipped (2026-05-06) — Steps 1–3 landed, then post-smoke remediation through Step 4 (ledger-authoritative re-keying, smoke failed) → Step 5 (rip-and-simplify: claude-id keying restored end-to-end, ledger narrowed to submission journal, per-message replay shape, HMR-mid-stream delivery chain explicit) → Steps 5.9/5.10/5.11 (post-close-out fixes for three independent delivery-chain failures uncovered by manual smoke) → orphan-interrupted submissions emit their own committed turn → Step 6 (close-out): N=20 deterministic green across all five distributed Smoke D test files, full check suite green, manual smokes user-confirmed (HMR mid-stream restores both halves of the in-flight turn; Cmd-Q before claude responds renders the orphan as its own pending entry on reopen) |
| Target branch | tugplan-tide-mid-turn-replay |
| Last updated | 2026-05-06 |
| Roadmap anchor | [tugplan-tide-transcript-resume.md #phase-a-r3](./tugplan-tide-transcript-resume.md#phase-a-r3) — extracted from there after one reverted attempt |
| Predecessors | [tugplan-tide-transcript-resume.md](./tugplan-tide-transcript-resume.md) (closed 2026-05-04, except the mid-turn case extracted here). The infrastructure this plan builds on — the request_replay verb, the active drain, the supervisor's Spawning-window queue, the JSONL translator — is all in place |
| Successors | TBD — depends on what the investigation finds |
| Related | [tugplan-tide-transcript-followon.md](./tugplan-tide-transcript-followon.md) — adapter polish, independent of this work |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Three smokes for the resume work shipped: HMR reload (A), Developer > Reload (B), and cold boot (C). The fourth, **Smoke D — mid-turn reload**, did not. A user who reloads while claude is mid-stream sees one of two failure modes today:

- **Pre-α** (the state at the start of this plan): the in-flight turn appears as `result: "interrupted"` in the transcript even though claude is still streaming the reply, and the actual completion lands in the JSONL on disk and never reaches the screen.
- **α (reverted)**: the card got stuck on the existing "Loading conversation" spinner for ~12s (the new `replay_deferred` placeholder lost the precedence chain), then rendered an empty assistant response (the JSONL flush race left the assistant entry unwritten when replay read it).

The α attempt was an architectural commitment built on speculation. Six pitfalls deep into the plan, none of which were verified against the actual wire, the design landed broken in two distinct ways. That post-mortem produced this plan's framing: **investigate first, design second.**

The fundamental architectural finding from the post-mortem:

> Live and replay use *different* `msg_id` schemes for the same logical turn. Live events carry tugcode's `crypto.randomUUID()` (minted by `newMsgId()` when `handleUserMessage` installs an `ActiveTurn`). Replay events carry claude's `message.id` (read from the JSONL file). Same logical turn, two different keys. Every "merge replay with live" design (D-1, D-2, α) had to bolt on reconciliation, and that's where the pitfalls came from.

The user's framing for the fix uses the architectural inversion: the card just fetches history, then naturally connects to whatever live stream is in progress. That works if and only if live and replay agree on the id. **Tugcode is the live id minter, and claude reveals its `message.id` on every stream event. Tugcode can use claude's id from the start.** Then the merge problem disappears: the reducer's existing msg_id-keyed accumulation stitches replay and live together with no special handling.

But before we commit to that design, three observable behaviors need to be confirmed. The investigation phase below pins each one.

#### Strategy {#strategy}

- **Investigate before designing.** Phase 0 captures observable behavior on the wire. No design is locked in until the questions are answered. The α attempt's failure was speculation outrunning observation; that mistake doesn't repeat.
- **Automate every experiment.** Phase 0 produces deterministic, repeatable evidence — Bash + tugcode test rigs + cargo tests, all runnable without human-in-the-loop reload-and-watch. The user is not a test monkey.
- **Durability before features.** "Never drop a message" is the hard requirement. Each layer that can drop a message gets characterized in the investigation; the design phase proves drops are impossible (or explicitly accepted with telemetry + recovery).
- **Build stays green at every commit.** `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` pass on every step. Warnings are errors.

#### Success Criteria (Measurable) {#success-criteria}

The plan succeeds when **all** of the following hold:

- Smoke D (mid-turn reload) passes manual + automated verification: the card shows the prior turns, the in-flight turn appears with the user prompt visible, the assistant text streams in to completion, and the final TurnEntry commits cleanly with both halves of the turn on screen — no duplicate row, no empty response, no stuck spinner.
- The same scenario, captured as an automated regression test, produces a deterministic green outcome on every run.
- A "drop audit" verifies that no message can be silently lost between claude's stdout and the tugdeck reducer in the reload-mid-turn scenario. Any potential drop point either: (a) is provably unreachable, (b) is gated by a buffer / queue with bounded capacity and an explicit telemetry signal on overflow, or (c) is recovered via re-fetch (e.g. the request_replay verb gives card v2 a way to ask for the JSONL again if it suspects loss).
- HMR cycles during development become viable for dogfooding: a developer using tugtool to develop tugtool can reload mid-turn and continue working without losing context. ("We would never be able to use this tool to modify the tool, if you get my meaning." — user, 2026-05-04.)

#### Scope {#scope}

1. **Phase 0 — Investigation** ([#phase-0]). Three automated experiments + one drop audit. No production code changes; all output is structured trace data + a written report.
2. **Phase 1 — Design** ([#phase-1]). Pinned by Phase 0's findings. Lays out the architecture (most likely: claude-id canonicalization + minimal reducer change) and the wire-protocol changes needed.
3. **Phase 2+ — Implementation.** Detailed once Phase 1 lands.

Out of scope:

- Cross-machine session export / import.
- Imperative DOM cell pooling.
- The adapter polish items (separate plan).

---

### Resolved Questions / Design Decisions {#design-decisions}

This section will fill in as the investigation produces evidence and the design phase records its decisions. Initially empty.

#### [DM01] Phase 0 must run before any design commitment {#dm01-investigate-first}

**Decision:** No production code touching live/replay merge ships before Phase 0 ([#phase-0]) lands its three reports + the drop audit. The α attempt's failure mode — "design committed to its premise before observing the system" — does not repeat.

**Rationale:**

- The post-mortem of α showed that two of the three failure modes (`replayPreflightActive` precedence, JSONL flush race) were observable from telemetry but were not observed before code shipped.
- The msg_id mismatch was named in the plan's pitfalls section but the resolution was bolted-on machinery instead of a structural fix.
- "Investigate first" is the discipline that worked in [Phase A-R0](./tugplan-tide-transcript-resume.md#phase-a-r0) of the resume saga (cold-boot diagnosis via telemetry capture before the realpath fix). The same discipline applies here.

#### [DM02] The investigation is automated {#dm02-automated-investigation}

**Decision:** Every Phase 0 experiment runs without a human reloading a browser, clicking a button, or watching for a banner. Each experiment is a script (`bun test`, `cargo nextest`, or a Bash harness) that produces a verdict — `PASS` / `FAIL` / structured timing data — readable by code.

**Rationale:**

- Manual smokes are slow (one cycle per minute under good conditions) and non-repeatable (timing varies; the question often hinges on microsecond-scale ordering).
- Automation pins the scenario so a regression in any layer breaks a CI test, not a vibe.
- The user's stated requirement: "I don't want to be a test monkey" (2026-05-04).

#### [DM03] Tugcode adopts claude's `message.id` as the canonical id for live events (RETIRED 2026-05-05 — see [DM07] / [Step 4](#step-4)) {#dm03-canonical-id}

**Retired:** Manual testing after Step 3 surfaced a deterministic bug — reload immediately after submit drops the user's submission and the streaming response until a second reload. Root cause: `ActiveTurn.msgId` starts as a placeholder UUID at install time and is only canonicalized to claude's `message.id` when `message_start` arrives. `request_replay` arriving in that window produces a `liveInflightMsgId` that doesn't match the JSONL's trailing-turn id (or matches nothing, if no assistant entry has been written yet), so the trailing-turn skip path doesn't fire and `emitInflightTurnFromActiveTurn` is gated out. Conversation with the user on 2026-05-05 surfaced that the "future merge feature" benefit this decision was supposed to preserve is not concrete — the only place we merge live and replay is the mid-turn case in this plan, and the canonicalization race introduced its own bug class. Step 4 replaces this approach with a ledger-authoritative turn id minted at user-submission time and persisted before any forward to claude — the id is stable from the moment of submission, the race window is closed, and the user's reported bug becomes structurally impossible. See [DM07].



**Decision:** `ActiveTurn.msgId` is captured from the first stream event of each turn that carries `message.id`. Live emits and replay emits then share an id for the same logical turn, and the reducer's existing `msg_id` dedupe ([D04] of the resume plan) handles the merge automatically. The current `crypto.randomUUID()` mint at `handleUserMessage` time is replaced.

**Rationale:**

- The msg_id divergence (live = tugcode UUID, replay = claude id) is the load-bearing root cause of every prior mid-turn merge attempt's failure. E2 confirmed the divergence on the wire.
- We control tugcode. Tugcode reads claude's stdout. Claude reveals `message.id` on every stream event. The data is right there.
- The reducer already handles "two events with the same `msg_id`" correctly (idempotent commit). It does NOT handle "two events with different `msg_id`s for the same logical turn" — that's what we've been trying to bolt on. Fixing the producer is structurally cleaner than fixing every consumer.
- One-time canonicalization at the source eliminates a class of future bugs where a feature accidentally exposes the divergence.

**Implications:**

- `ActiveTurn` constructor takes the placeholder UUID off the hot path. The `msgId` field becomes mutable until first stream event and then frozen.
- Anywhere live events emit before `message.id` is known: there is no such site today. The drain calls `dispatchEventToTurn` only on stdout-line arrivals, and the first arrival carries `message.id`. Verified during Step 1.
- Pre-existing call sites that read `ActiveTurn.msgId` (logs, the `signalEofToActiveTurn` emit path) get an updated value after first stream event. None of them snapshot the id before that point in production paths.

**Alternative considered:** translator emits the trailing in-flight turn's events with tugcode's UUID instead of claude's id. **Rejected** because the divergence still exists for any future feature that wants to merge live + replay; the alternative only patches the trailing-turn case.

#### [DM04] In-flight turn content is emitted from `ActiveTurn`, not from JSONL (DECIDED — Phase 1) {#dm04-active-turn-source}

**Decision:** When `runReplay` runs against a JSONL whose trailing turn is the one currently in flight (`this.activeTurn?.msgId` matches the trailing assistant entry's id, per [DM03]), tugcode emits the in-flight turn's content from `ActiveTurn` state — the user's prompt (newly stored), accumulated `partialText`, recorded tool calls — not from the JSONL's partial assistant entry. JSONL stays the source of truth for *committed* turns.

**Rationale:**

- E1 confirmed JSONL trails stdout `result` by 2-6ms. That's small but always positive; under load the tail extends. Reading JSONL the instant `result` arrives consistently sees an incomplete file.
- Tugcode already has the in-flight turn's content in memory: `partialText` accumulates as deltas arrive; tool calls and approvals pass through `dispatchEventToTurn`. The data is fresher and more complete than JSONL.
- The user's prompt is currently NOT stored on `ActiveTurn`; that's a small one-field addition (`userText: string`).
- This is the inversion that closes E1's race: the wire reflects tugcode's authoritative state, not a derivative on disk.

**Implications:**

- `ActiveTurn` gains a `userText: string` field, set by `handleUserMessage` from the inbound `UserMessage`'s text.
- `runReplay` reads `this.activeTurn` at entry. If non-null and matching the JSONL's trailing turn, the translator skips the trailing turn (per [DM05]) and tugcode emits a `user_message_replay` + accumulated `assistant_text` + recorded tool events using `ActiveTurn` state.
- The translator's existing JSONL → events translation is unchanged for committed turns; the in-flight turn diverts to the new tugcode-side emission path.

**Alternative considered:** make tugcode wait some extra ms after `result` for JSONL to settle (a "settle window"). **Rejected** because timing-fragile and adds latency. The right answer is to use the data tugcode already has.

#### [DM05] Translator skips orphan synthesis when tugcode signals the live in-flight trailing turn (RETIRED 2026-05-05 — see [DM07] / [Step 4](#step-4)) {#dm05-orphan-handoff}

**Retired:** [DM05]'s id-match predicate ("skip if `liveInflightMsgId === ctx.buffer.msgId`") is conditional on [DM03]'s canonicalization succeeding before reload. The race window in [DM03] therefore breaks [DM05] too: if `liveInflightMsgId` is the placeholder UUID, no trailing turn matches, and the translator orphan-synthesizes the in-flight turn under claude's id while ActiveTurn carries the placeholder — two TurnEntries for one logical turn. Step 4 replaces the id-match predicate with a row-driven replay path: tugcode iterates the ledger's `turns` rows for the session, emits each keyed by the row's `tug_turn_id`, and consults JSONL only for content lookup by `claude_message_id`. The translator no longer drives identity at all; the orphan-synthesis path survives only for the cold-boot case where the ledger has no rows for the session (legacy / migration). See [DM07].



**Decision:** `translateJsonlSession` gains an option `liveInflightMsgId?: string`. When set, the translator's end-of-JSONL flush behaves differently: if the trailing turn's terminal assistant entry has `message.id === liveInflightMsgId`, the translator emits no events for that turn at all (tugcode's own emission path covers it per [DM04]), and skips the synthetic `turn_complete{interrupted}` per [D08] of the resume plan. When `liveInflightMsgId` is unset, the existing orphan-synthesis behavior is preserved (cold-boot replays of JSONLs that end mid-turn from a previous interrupted session still synthesize the orphan).

**Rationale:**

- [D08] orphan synthesis is correct for cold-boot of an interrupted session. It is wrong when the trailing turn is the one tugcode is currently streaming locally. The two cases are distinguishable: tugcode either has an `ActiveTurn` for that id or doesn't.
- A single optional flag is the minimal protocol change. No new wire shapes; no new translator vocabularies.
- Keeping the cold-boot orphan-synthesis path preserves [D08]'s contract for the case it was designed for.

**Implications:**

- `tugcode/src/replay.ts` accepts the new option in `TranslateSessionOptions`.
- `tugcode/src/session.ts::runReplay` populates the option from `this.activeTurn` at entry time.
- The translator's existing per-turn buffer detection (already in place for [D08]) does the matching; if the trailing turn's `message.id` equals `liveInflightMsgId`, skip; otherwise proceed as today.

**Alternative considered:** strip [D08]'s synthesis entirely and rely on tugcode-side detection in all cases. **Rejected** because it loses the cold-boot interrupted-session signal that today's `result: "interrupted"` row provides for legitimately-orphaned JSONLs.

#### [DM06] Live emit for the in-flight turn is suppressed during `runReplay`'s window (DECIDED — Phase 1) {#dm06-suppress-during-replay}

**Decision:** `ActiveTurn` gains a `suppressEmit: boolean` field. When `runReplay` enters with a matching active turn, it sets `suppressEmit=true` on that turn, runs the replay (which emits committed turns from JSONL plus the in-flight turn's coherent block from ActiveTurn state per [DM04]), then clears `suppressEmit` after the closing `replay_complete` is on the wire. While suppressed, the drain's `dispatchEventToTurn` updates `ActiveTurn` state (`partialText`, `gotResult`, etc.) but does NOT call `writeLine` for that turn's events. After unsuppress, the drain resumes emitting normally — any deltas accumulated during the window arrive as the resume's first emits, keyed by claude's `message.id` ([DM03]).

**Rationale:**

- E2 confirmed live and replay events for the same in-flight turn interleave on the wire and that live events outside the bracket get dropped at the reducer's phase guard. Both problems disappear if tugcode emits one coherent block for the in-flight turn inside the bracket.
- This is **NOT** the α design that was reverted. α's failure was emitting from JSONL after suppression cleared, hitting E1's race; [DM06] emits from `ActiveTurn` state ([DM04]) inside the bracket, so the race is irrelevant.
- The suppression window is short (~tens of ms — `runReplay` is fast). Deltas accumulated during the window are not lost; they ride out as live events post-bracket.
- Tugcode is the natural serialization point — it owns both the drain and `runReplay`.

**Implications:**

- `dispatchEventToTurn` checks `turn.suppressEmit` at each per-turn `writeLine` site (mirrors the seven-site pattern catalogued in the reverted α; the difference is what happens during the window, not the gating mechanism).
- `signalEofToActiveTurn` similarly honors `suppressEmit` (its emits are also per-turn).
- `runReplay`'s post-bracket cleanup unconditionally clears `suppressEmit` on the active turn (defensive: the state must not persist across replays).

**Pitfall: claude crash during the suppressed window.** If claude's stdout EOFs while `runReplay` is mid-iteration (claude crashed, killed, or the subprocess otherwise dies), the drain hits EOF and calls `signalEofToActiveTurn`. With `suppressEmit=true`, that handler's `turn_cancelled` / `error` `writeLine` is skipped — but `turn.finish()` still runs, so the active turn ends. After replay events finish, `runReplay` calls `emitInflightTurnFromActiveTurn` (per [DM04]). Without explicit handling, the synthesized block emits `user_message_replay` + `assistant_text` but **no terminal event**, because no `gotResult` arrived. After `replay_complete` and suppression clearing, the drain is dead (EOF), so no live `turn_complete` ever arrives. The reducer's `pendingUserMessage` stays set, scratch has assistant text, but the TurnEntry never commits — the in-flight turn dangles. **Mitigation:** `emitInflightTurnFromActiveTurn` checks `turn.gotResult` / `turn.interrupted` and emits the appropriate terminal event (`turn_complete` for `gotResult`, `turn_cancelled` for `interrupted`) inside the bracket. See [#emit-inflight] for the spec; pinned by Step 3's tests.

**Alternative considered:** rely on the reducer to dedupe + reorder. **Rejected** because today's reducer drops events outside the active phase set, and changing that surface area is a larger blast radius than fixing tugcode's wire-emit ordering at the source.

#### [DM07] Tugbank `SessionLedger.turns` is the authoritative source of turn ids; tugcast mints, tugcode uses, ledger persists (RETIRED 2026-05-05 — see [DM08] / [Step 5](#step-5)) {#dm07-ledger-authoritative}

**Retired:** Step 4 shipped the eight-substep ledger-authoritative redesign as authored. All unit and integration tests passed (602 tugcast + 322 tugcode). The simplest end-to-end smoke test then failed in user dogfooding: type "hello", wait for response, `Developer > Reload`, expect transcript restored — actual: empty window. Two architectural commitments around the same problem (canonicalize live to claude's id; mint a tugcast id and bridge it) had now produced two non-functional code messes. The user's diagnosis on 2026-05-05 named the design itself as the problem: *"Three independent paths (live insert, ledger replay, cold-boot fallback) each with their own id semantics, plus a 'migration' that has to bridge them, and any platform path-resolution wrinkle takes the whole thing down."* The remediation is [DM08]: revert wire keying to claude's `message.id` (drop `tug_turn_id` from envelopes), narrow the ledger to a *submission journal* whose only job is plugging the "tugcode crashes before claude responds" hole, and let `translateJsonlSession` resume being the single replay source with a one-line predicate fix to emit in-flight turns instead of filtering them. The original Decision/Rationale/Implications/Alternatives below are preserved verbatim for audit.

**Decision:** Per-turn identity moves from "minted by tugcode + canonicalized from claude's id" ([DM03]) to **"minted by tugcast at user-submission time, persisted to a new `turns` table in the existing `SessionLedger` sqlite database, and propagated to tugcode via the inbound `user_message` envelope."** The id is named `tug_turn_id` (UUID v4) and is the single source of truth for the reducer's `msg_id` key for live and replay events. Claude's `message.id` is captured as a secondary `claude_message_id` field on the ledger row when claude completes the turn — used to look up content in JSONL during replay, never used as the reducer's key.

**Rationale:**

- The id is durable from the moment of submission. No race window; no canonicalization step; no two-id-scheme partition.
- Tugcast is the single sqlite writer (it already owns `SessionLedger`), so the row is persisted *before* the user_message is forwarded to tugcode and *before* tugcode writes to claude.stdin. A tugcode crash in the window that today loses the user's submission instead leaves a `state: 'pending'` row in the ledger that next session start can surface.
- The reducer's `msg_id` keying is unchanged (load-bearing [D04] dedupe). What changes is which actor mints the id and where it persists.
- The mid-turn replay's `liveInflightMsgId` match-up problem disappears: tugcode reads the ledger's `turns` rows directly during `runReplay`, emits each row keyed by its `tug_turn_id`, and skips the JSONL-translator's identity logic entirely. The translator becomes a content-extraction utility looked up by `claude_message_id`.
- Stable `tug_turn_id` across reload unlocks transcript-management features the user has on the roadmap (scroll-restore, turn references, sharing, edit-previous-turn, diff). These were the actual reason "two id schemes coexist" was unacceptable — the project's value proposition is *managing the experience of submitting requests and getting responses well*, and stable identity is foundational to that.

**Implications:**

- `SessionLedger` gains a `turns` table (FK to `sessions.session_id`) plus a `migrations` table (this is the second schema variant; the existing one-table schema dodges migrations).
- Tugcast supervisor intercepts inbound `user_message` to mint `tug_turn_id` + insert the row, and intercepts outbound `turn_complete` to update the row with `claude_message_id`.
- Wire shape: `user_message` (inbound to tugcode) gains `tug_turn_id`; `turn_complete` (outbound from tugcode) gains `claude_message_id`. Reducer ignores these fields (it already keys by `msg_id` on the wire frame).
- Tugcode opens the `sessions.db` read-only via Bun's `bun:sqlite` for `runReplay`. WAL mode supports the writer (tugcast) + reader (tugcode) pair on the same file with no contention.
- All [DM03] and [DM05] plumbing is removed. `ActiveTurn.msgId` returns to `readonly`. `canonicalizeMsgId`, `messageId` fields on `EventMappingResult` / `TopLevelRoutingResult`, the `message_start` branch in `mapStreamEvent`, and the id extraction in `routeTopLevelEvent`'s `case "assistant"` all go away. `claude_message_id` is captured as informational state (`ActiveTurn.claudeMessageId: string | null`) for the `turn_complete` payload — the same plumbing that surfaced "messageId" before is partially restored, but the destination is informational, not canonical.
- Migration: pre-existing sessions have `sessions` rows but no `turns` rows. On first open, tugcast scans JSONL, mints `tug_turn_id` per turn, and bulk-inserts. One-time per session, idempotent.

**Alternatives considered:**

- **Place the new table in tugbank** (the existing `tugbank-core` typed defaults store). **Rejected:** tugbank is explicitly authored as a "SQLite-backed typed defaults store" modeled after Apple's `UserDefaults` — domain-keyed, generation-counter-based, optimized for settings/preferences. Per-turn live-data writes are the wrong fit; you'd be misusing the abstraction.
- **A new dedicated turn store / sqlite database**. **Rejected:** more operational surface (another file, another connection pool, another migration story) for no benefit. `SessionLedger` already provides everything we need; adding a table is the cheapest move.
- **A tugcode-side persistence store** (Bun's `bun:sqlite` writing alongside reading). **Rejected:** two writers across processes (tugcast for sessions, tugcode for turns) would either contend for the same database or split into two databases that need to stay coherent. Single-writer is operationally cleaner.
- **Rewrite or wrap claude's JSONL.** **Rejected:** races claude's writes; breaks compatibility with other tools that read claude's JSONL; more complex than the ledger approach with no additional benefit.
- **Embed `tug_turn_id` in the user prompt envelope** so claude echoes it through JSONL (tugcode's stdin → claude → JSONL user entry). **Useful as a complement** — cheap diagnostic-correlation aid that round-trips the id through JSONL — but **insufficient on its own:** claude generates assistant entries server-side; we can't tag those. Tracked as a follow-on if/when log-correlation grep-ability becomes a pain point.

#### [DM08] Wire is keyed by claude's `message.id`; the ledger is a submission journal only (DECIDED — Phase 1, Step 5) {#dm08-submission-journal}

**Decision:** Per-turn identity on the wire reverts to claude's `message.id`, the way it was before [DM03]'s canonicalization attempt and [DM07]'s ledger-authoritative attempt. The `turns` table introduced in [Step 4.1](#step-4-1) survives, but its role narrows from "transcript identity authority" to **"durable journal of pending submissions that claude has not yet acknowledged in JSONL."** A row is inserted at the moment tugcast forwards `user_message` to tugcode (already implemented in [Step 4.3](#step-4-3)) and is **deleted** as soon as the merger sees the corresponding `turn_complete` (FIFO match against the session's pending rows). The journal id (formerly `tug_turn_id`) is internal to tugcast and is **not surfaced on the wire** — neither inbound `user_message` nor outbound `turn_complete` carries it. Tugcode's `runReplay` queries the journal via the read-only sqlite handle (already opened in [Step 4.5](#step-4-5)) only to recover submissions that crashed before claude acknowledged them — those are emitted as synthetic `user_message_replay` frames before the JSONL translator pass runs.

**Design goals (verbatim from user 2026-05-05):**

> "The front end is not doing much work. The reducer's existing msg_id-keyed accumulation handles everything. Claude Code keeps ticking. Tugcast keeps ticking. The card just observes."

> "We must NEVER drop a message on the floor — one way or another."

**Rationale:**

- The Step 4 design conflated two concerns into one mechanism: (1) "what is the durable identity for transcript-management features (scroll-restore, share, edit-previous-turn, diff)?" and (2) "how do we restore the transcript across reload?" Concern (1) needs a stable, durable id. Concern (2) does not — it just needs the wire frames to arrive and the reducer's msg_id-keyed accumulation to do its job. By trying to solve both with the same id, Step 4 introduced a re-keying step in the replay path (translate claude's id from JSONL into tugcast's id from the ledger) that became the failure surface.
- Reverting wire keying to claude's `message.id` collapses the three Step 4 paths (live insert + augmented frame; ledger-driven runReplay; cold-boot translator fallback) into one: tugcode forwards what claude says, keyed by what claude says. Resume reads JSONL via `translateJsonlSession` and emits frames keyed by what JSONL says (claude's ids). One id space; one path; the reducer's existing accumulation does the work.
- The "tugcode crashes before claude responds" hole — the gap that justified persisting *anything* tugcast-side — is plugged structurally by the journal alone. The journal records the submission immediately; on resume, tugcode injects a synthetic `user_message_replay` for any pending row not yet represented in JSONL, so the user's submission renders as "awaiting response" rather than vanishing. Concern (2) is solved without coupling identity to the journal.
- Concern (1) — durable identity for transcript-management features — is addressed by **claude's `message.id` in JSONL**. Claude writes the user_message line and the assistant message line to JSONL with stable claude-side ids that survive reload, tugcode restart, tugcast restart, and Tug.app restart. Features keyed off these ids work across all those events. The pre-acknowledgement window (user submitted, claude not yet responded) is the only window where claude's id doesn't exist yet; in that window the journal id is a temporary key that the reducer's pendingUserMessage slot rebinds to claude's id when the first response frame arrives.

**Implications:**

- Wire shape reverts: `UserMessage` no longer carries `tug_turn_id`; `TurnComplete` no longer carries `claude_message_id`. Both fields added in [Step 4.2](#step-4-2) come off.
- Tugcode's adoption changes: `ActiveTurn.msgId` is no longer sourced from the inbound envelope. The pre-Step-4 mechanism returns — `msgId` starts as a `crypto.randomUUID()` placeholder at install time and migrates to claude's `message.id` once the first stream event arrives. The DM03 race window that Step 4 was designed to close is reopened, but it doesn't matter: the *failure mode* of that race (replay can't match the in-flight turn) is plugged by the journal-driven pending-row replay (the user's submission is rendered from the journal, not from a translator id-match).
- Tugcode's `runReplay` rewires: `runLedgerDrivenReplay` is deleted; `extractTurnContent` is deleted. The pre-Step-4 `translateJsonlSession` call site returns. New logic before the translator pass: `SELECT user_text, attachments FROM turns WHERE session_id = ? ORDER BY created_at` — for each pending row whose `user_text` does not appear as a `user_message` line in the JSONL, emit a synthetic `user_message_replay` (no terminal `turn_complete`; the reducer's `pendingUserMessage` slot holds it).
- Translator predicate fix: `translateJsonlSession`'s end-of-JSONL flush, when the trailing turn has no `end_turn`, currently synthesizes a `turn_complete{interrupted}` (the [D08] orphan-synthesis path). For the in-flight case (the original 2026-05-05 mid-turn bug), this predicate changes: emit `user_message_replay` + accumulated `thinking_text` / `assistant_text` content, but **no terminal event**. The reducer's `pendingUserMessage` and `scratch[msgId]` stay populated; live frames continuing post-replay produce the eventual `turn_complete` naturally. Reducer is unchanged.
- Ledger schema narrows: the `turns` table loses `claude_message_id`, `partial_text`, `completed_at` — those columns existed to bridge ids and back-reference content, both of which are gone. The state column collapses to "row exists = pending; row deleted = seen." `mark_turn_complete`, `mark_turn_interrupted`, `record_partial_text`, `list_turns_for_session` (or its content-bearing variant) are removed from the API. `insert_pending_turn` (renamed to reflect the journal role), `delete_oldest_pending_for_session` (FIFO match), and `reconcile_pending_for_session` survive.
- Migration scaffolding deleted: `bootstrap_turns_from_jsonl` was bridging legacy JSONL into the ledger so replay could find tug_turn_ids for old sessions. With the wire keyed by claude's id and JSONL the replay source, no migration is needed — the ledger only ever holds *currently pending* submissions, never historical ones. `jsonl_reader.rs` (the minimal Rust JSONL parser added for migration), `bootstrap_turns_from_jsonl`, and `canonical_project_dir_for_jsonl` (the macOS firmlink path resolver) all come out.
- Reducer is unchanged. `handleReplayStarted`, `handleUserMessageReplay`, `handleTextDelta`, `handleTurnComplete` all continue to operate on whatever `msg_id` arrives. Since claude's ids flow through unchanged, accumulation works without modification. The pendingUserMessage slot's existing behavior (set on user_message_replay, paired with scratch on turn_complete) handles the temporary-key migration described above.
- Stable identity for transcript-management features (the [DM07] motivation) is now claude's `message.id` from JSONL. For pre-acknowledgement turns there is no stable id — but a feature targeting an unacknowledged turn would itself be racy (the turn might not exist yet from claude's perspective), so this isn't a real loss.

**Alternatives considered:**

- **Keep [DM07], debug the smoke test failure.** Rejected after the user's 2026-05-05 critique: the code review of every link in the chain (ledger row, JSONL extraction, translator re-key, wire emit, broadcast, reducer) showed each step looking correct in isolation, yet the integration silently produced empty output. Two independent rebuild-test cycles failed to surface the root cause. Continuing to debug a four-path design with re-keying at runtime risked spending more dogfooding time on the same fragility.
- **Add `'in_progress'` as a third value to `TurnEntry.result`** so in-flight turns get a terminal event. Rejected because it requires a reducer change, breaking the "reducer is unchanged" property the user explicitly named as a load-bearing simplicity goal. The chosen alternative — emit no terminal event for in-flight turns and let live continuation produce it — gets the same UX with zero reducer churn.
- **Reuse `'interrupted'` for in-flight turns.** Rejected because it conflates two distinct UX states (the turn is still streaming vs. the turn was canceled). UI code downstream of TurnEntry would need a side-channel hint to distinguish them.
- **Drop the journal entirely and rely on claude's `--replay-user-messages` to recover submissions.** Rejected because that flag replays user messages claude has *already received and processed*. Submissions that crashed before claude received them would still be lost. The journal is the only mechanism that captures the submission durably the moment tugcast intercepts the inbound frame, so it's the only mechanism that satisfies the never-drop guarantee.
- **Rewrite or wrap claude's JSONL.** Rejected for the same reasons as in [DM07].

---

### Phase 0 — Investigation {#phase-0}

**Goal.** Answer four observable questions before any production code changes:

1. [E1] **JSONL flush timing.** When claude emits the `result` event on stdout for a turn, has it already flushed the final assistant entry to the JSONL file?
2. [E2] **Live/replay ordering.** When `runReplay` runs while claude is still streaming for the same in-flight turn, in what order do replay events and live events arrive at tugdeck? Are they consistent? Are they reconcilable?
3. [E3] **Tugcast subscriber buffering.** When a WebSocket client disconnects and reconnects, what events does the new connection see? Are events emitted during the disconnect window delivered, dropped, or replayed?
4. [E4] **Drop audit.** Across the full path (claude stdout → tugcode → tugcast → tugdeck reducer), where can a message be silently lost? Each potential drop point must be characterized: under what conditions does it drop, and what's the recovery story?

Each experiment produces:

- A runnable script / test file, committed to the repo
- A structured trace output (JSON or human-readable text)
- A written verdict (a paragraph in this plan, post-experiment)

The verdicts together form the input to [Phase 1 — Design](#phase-1).

#### Experiment E1 — JSONL flush timing {#e1-jsonl-flush-timing}

**Question.** When claude (the binary at `/Users/kocienda/.local/bin/claude`, version 2.1.128) emits a `result` event on stdout in stream-json mode, has it already flushed the final assistant entry (the one with `stop_reason: end_turn`) to the JSONL file at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`?

**Why it matters.** If `result` arrives BEFORE the JSONL flush, then `await activeTurn.completion` resolves before JSONL has the data. Any "wait for completion then read JSONL" design ([α](#)) hits an empty/partial JSONL and emits an incomplete turn. This was the "empty assistant response" failure mode in the reverted α attempt.

**Hypothesis.** Two possibilities, only one of which is true:

- **H1a (race exists).** Claude emits `result` to stdout asynchronously vs. the JSONL write. Tugcode reading JSONL right after `result` may see partial state. Implication: any mid-turn replay design must NOT rely on JSONL being current at the moment `result` arrives. Either wait extra (timing-fragile), poll JSONL until stable (timing-fragile), or use tugcode's own ActiveTurn state instead of JSONL for the in-flight turn.
- **H1b (no race).** Claude flushes JSONL atomically before emitting `result`. The two are sequenced. Tugcode reading JSONL right after `result` always sees the complete turn. Implication: a "wait for completion then read JSONL" design is sound; α's empty-response failure must have come from somewhere else.

**Harness design.** A standalone Bash script that:

1. Spawns `claude --print --output-format stream-json --include-partial-messages` with a deterministic prompt (e.g. `"reply with exactly the string FOO and nothing else"`).
2. Captures stdout line-by-line with monotonic timestamps.
3. Polls the corresponding JSONL file (path computed from `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`) at high frequency, recording the file's modification time and size at every poll.
4. After the turn completes, computes:
   - `t_result_stdout` — wall-clock when `{"type":"result"}` appeared on stdout
   - `t_jsonl_complete` — wall-clock when the JSONL contained the final assistant entry with `stop_reason: end_turn`
5. Reports `t_jsonl_complete - t_result_stdout` (positive = race exists; negative or zero = no race).

**Implementation location.** New file: `tugcode/scripts/investigate-jsonl-flush-timing.sh` (or `.ts` if Bun's better-suited).

**Verdict format.** Single-paragraph summary in this plan section, plus the captured trace as an appendix file under `dash/tugplan-tide-mid-turn-replay-traces/e1-jsonl-flush-timing.json`.

**How I run it.** `bash tugcode/scripts/investigate-jsonl-flush-timing.sh > traces/e1-trace.json && bun run scripts/analyze-e1.ts < traces/e1-trace.json`. No human in the loop; result is `PASS` (race characterized + verdict known) or `FAIL` (claude unavailable or unexpected output shape; needs investigation before retry).

**Verdict — H1a confirmed (race exists).**

Across 10 runs of the deterministic prompt `"reply with exactly the string FOO and nothing else"` against `claude --output-format stream-json --input-format stream-json --include-partial-messages --replay-user-messages` on this machine (claude 2.1.128), the JSONL's first `assistant` entry with a non-null `stop_reason` always landed **after** the `result` event arrived on stdout. Stats:

| Metric | Value |
|-|-|
| Runs | 10 / 10 with positive offset |
| Min `t_jsonl_complete - t_result_stdout` | **2 ms** |
| Max | **6 ms** |
| Mean | **4.2 ms** |
| Median | 4 ms |
| Stddev | 1.66 ms |

Raw deltas (sorted, ms): `[2, 2, 3, 3, 3, 5, 6, 6, 6, 6]`. Trace files: `dash/tugplan-tide-mid-turn-replay-traces/e1-batch-run-{01..10}.json`. Aggregate: `dash/tugplan-tide-mid-turn-replay-traces/e1-batch-summary.json`.

**Implication for design (load-bearing):**

A "wait for `result` on stdout, then read JSONL" design (the abandoned α) is unsound in principle — the JSONL is consistently incomplete at the moment of `result`. Even small budgets like 2ms would have to handle the long tail. The empty-assistant-response failure mode in the reverted α was likely this race surfacing under load. **The right answer is to not depend on JSONL for the in-flight turn at all** — tugcode has the in-flight turn's content in its own `ActiveTurn.partialText` (and elsewhere in the per-turn drain state) before `result` arrives, so the in-flight turn can be reconstructed from tugcode's own state. JSONL remains the source of truth for *committed* turns where the race is irrelevant (claude's previous-turn assistant entry has been on disk for seconds before reload).

#### Experiment E2 — Live/replay ordering during the replay window {#e2-live-replay-ordering}

**Question.** While `runReplay` is iterating its translator output and emitting replay events on tugcode's stdout, the drain task is also forwarding live stream events from claude. In what order do these two streams interleave on the wire? Is the ordering deterministic? Can the reducer reconstruct the correct accumulated state regardless of order?

**Why it matters.** With α we tried to suppress live events during the replay window. The simpler design (claude-id canonicalization) makes that unnecessary IF the reducer's existing accumulation is order-tolerant. We need to characterize the actual interleaving and test the reducer against it.

**Hypothesis.** Three possibilities:

- **H2a (no overlap).** When `runReplay` is dispatching, the drain has nothing to forward (claude is silent during JSONL read). Replay events flow in a clean block, then live picks up. The reducer's existing handlers are sufficient.
- **H2b (overlap with same id, accumulation safe).** Replay and live events for the same in-flight turn interleave on the wire, but both use the same `msg_id` (claude's `message.id`) and the reducer's text accumulation is idempotent or replace-on-final. The reducer commits the right TurnEntry regardless of order.
- **H2c (overlap with same id, accumulation unsafe).** Replay and live events for the same in-flight turn interleave, but the reducer's `is_partial: true` (append) vs. `is_partial: false` (replace) logic produces different text depending on order. The reducer needs ordering guarantees, OR the wire needs a serialization point.

**Harness design.** A new tugcode test file: `tugcode/src/__tests__/replay-spawn-mid-turn.test.ts`. The test:

1. Builds a `SessionManager` in resume mode with a JSONL fixture containing N committed turns + a trailing in-flight turn (assistant entry with `stop_reason: null`).
2. Mocks claude's stdout with a controllable `ReadableStream` so the test scripts byte-by-byte timing of stream events.
3. Drives the scenario:
   - Install an `ActiveTurn` (simulating handleUserMessage).
   - Start drain forwarding live events at a controllable rate.
   - Concurrently invoke `runReplay()`.
   - Capture every `writeLine` call to mocked `Bun.stdout` with monotonic seq.
4. Asserts the captured wire output: do replay events and live events interleave? In what pattern? Are they reconcilable by the reducer?
5. Replays the captured wire into a fresh `CodeSessionStore` instance and asserts the resulting `transcript` matches the expected committed turns + the in-flight turn's full content.

**Implementation location.** `tugcode/src/__tests__/replay-spawn-mid-turn.test.ts`.

**How I run it.** `cd tugcode && bun test src/__tests__/replay-spawn-mid-turn.test.ts`. Output is the standard bun-test pass/fail with descriptions.

**Verdict format.** Single-paragraph summary + the test file's assertions become the documented contract.

**Verdict — H2c confirmed: msg_id divergence visible on the wire.**

The interleaved-test wire trace (full output preserved in test stdout; rerunnable):

```
type=session_init
type=assistant_text msg_id=1d1ab81a-...     ← LIVE event (tugcode UUID)
type=replay_started
type=system_metadata
type=user_message_replay msg_id=msg_committed_1
type=assistant_text       msg_id=msg_committed_1
type=turn_complete        msg_id=msg_committed_1
type=user_message_replay msg_id=msg_inflight_claude_id_2  ← REPLAY trailing turn (claude's id)
type=assistant_text       msg_id=msg_inflight_claude_id_2
type=turn_complete        msg_id=msg_inflight_claude_id_2 ← orphan-synthesized per [D08]
type=replay_complete
type=assistant_text msg_id=1d1ab81a-...     ← LIVE event (tugcode UUID, AFTER replay)
```

Three load-bearing observations:

1. **Live and replay events DO interleave on the wire**, even within a single `runReplay` invocation. The first live `assistant_text` lands BEFORE `replay_started`, the second AFTER `replay_complete`. They straddle the bracket rather than being contained by it.

2. **The msg_id divergence is real and confirmed.** Replay events for the trailing in-flight turn use `msg_inflight_claude_id_2` (claude's `message.id` from JSONL). Live events use a tugcode UUID (`1d1ab81a-...`, minted by `newMsgId()` when `ActiveTurn` was installed). The reducer keys by `msg_id`; same logical turn, two keys → reducer treats them as two turns.

3. **Live events that land outside the replay bracket are silently dropped at the reducer.** Pre-`replay_started`, phase is `idle`; `handleAssistantText` drops in `idle`. Post-`replay_complete`, phase is back to `idle`; same drop. So today's wire-shape, even before any "merge" attempt, *loses* the live deltas at the reducer.

**Implication for design.** Three things must change before mid-turn replay can work:

- The msg_id divergence must be eliminated. Two options: (a) tugcode learns claude's `message.id` from the first stream event and uses it as canonical for live emits; (b) the translator emits the trailing in-flight turn's events with tugcode's UUID instead of claude's id. Either path makes the reducer's existing dedupe handle the merge. Option (a) is structurally cleaner (it's a one-time canonicalization at the source) and has the bonus of making live and replay reconcilable for any future feature that needs it. Option (b) is a smaller code change but only fixes the trailing-in-flight-turn case.
- The translator must NOT orphan-synthesize a `turn_complete{interrupted}` for the trailing turn when tugcode signals the turn is the live in-flight one. Otherwise we double-commit (one interrupted from replay, one completed later from live).
- The reducer must accept live events for the in-flight turn's `msg_id` even outside the active phase set. Either by extending the phase allowlist for the matching `activeMsgId`, or by ensuring the bracket cleanly contains the live events (which requires tugcode-side ordering control).

#### Experiment E3 — Tugcast subscriber buffering {#e3-tugcast-buffering}

**Question.** When a WebSocket client (tugdeck) disconnects from tugcast and a new client reconnects, what events does the new client see? Specifically: are events emitted by tugcast during the disconnect window (a) delivered to the reconnected client, (b) dropped, or (c) replayed on demand?

**Why it matters.** The reload-mid-turn scenario disconnects and reconnects the WebSocket. During the disconnect window (typically tens to hundreds of milliseconds), claude keeps streaming, tugcode keeps emitting, tugcast keeps receiving. If those events are dropped, card v2 sees a discontinuity. If they're buffered, card v2 catches up. If they're replayed via request_replay, the request_replay verb is the recovery story.

**Hypothesis.** Three possibilities:

- **H3a (drops by default).** Tugcast forwards events to active subscribers only. Disconnect drops the subscriber; events emitted during the gap go to /dev/null. Reconnect starts fresh. Implication: card v2 must rely entirely on JSONL replay + live forwarding from the reconnect point to reconstruct.
- **H3b (per-session buffering).** Tugcast holds a per-session ring buffer (or unbounded buffer) of recent events; on reconnect, the new client receives a replay of the buffer. Implication: card v2 might see duplicates of events that JSONL replay also covers.
- **H3c (something else — needs investigation).** A different mechanism (subscriber-resumption tokens, durable streams, etc.) is in play.

**Harness design.** A Rust test in `tugrust/crates/tugcast/tests/`. The test:

1. Spawns the tugcast supervisor in-process (or via a controllable harness — check what `tests/` directory in tugcast offers today).
2. Establishes a WS client connection, subscribes to a session.
3. Drives a tugcode subprocess (or a stub that emits scripted events) producing a sequence of CODE_OUTPUT frames at known timestamps.
4. Disconnects the WS client mid-stream.
5. Lets the supervisor receive N more events while the client is offline.
6. Reconnects a new WS client (or re-subscribes the same client) and observes what's delivered.
7. Asserts the observed delivery pattern against H3a / H3b / H3c.

**Alternative path.** If standing up a real tugcast in a test is too heavy, instrument the existing supervisor + subscriber code paths with telemetry; capture a real run via `just dev-tugcast` and a programmatic WS client; analyze the resulting trace.

**Implementation location.** TBD — depends on what tugcast's existing test infrastructure supports. Investigation step #1 is to read the tugcast `tests/` directory + `feeds/agent_supervisor.rs` and pick the right integration point.

**How I run it.** `cd tugrust && cargo nextest run -p tugcast --tests` (after the test is written).

**Verdict — H3a confirmed: tugcast drops disconnect-window frames for fresh subscribers.**

Three sub-tests in `tugrust/crates/tugcast/tests/e3_subscriber_buffering.rs` (all passing):

- `e3_fresh_subscriber_sees_only_post_subscribe_frames`: a `broadcast::Sender` with capacity 1024 (mirroring `CODE_BROADCAST_CAPACITY`). Pre-subscribe sends are not delivered to a later subscriber; only post-subscribe sends arrive.
- `e3_disconnect_then_reconnect_loses_disconnect_window_frames`: card v1 subscribes, drains 3 frames, drops the receiver. Frames 4-8 are sent during the disconnect. Card v2 subscribes anew and sees only frames 9-11. Frames 4-8 are silently dropped from card v2's perspective.
- `e3_lag_recovery_is_for_existing_subscribers_only`: tokio's `broadcast` surfaces `RecvError::Lagged(N)` to an existing slow subscriber. The router's `LagPolicy::Replay` reacts to that signal by replaying from the shared `ReplayBuffer` (1000 frames). This path is for *existing* slow subscribers — it does NOT help a *new* subscriber catching up after disconnect-then-reconnect.

**Architectural facts confirmed by code reading:**

- `feeds/code.rs::CODE_BROADCAST_CAPACITY = 1024`.
- `main.rs:313` wires `code_replay = ReplayBuffer::new(1000)` and `LagPolicy::Replay(code_replay)` for `FeedId::CODE_OUTPUT`.
- `router.rs:402` calls `tx.subscribe()` per fresh client → fresh `broadcast::Receiver`. No catchup mechanism on connect.

**Implication for mid-turn reload.** Any CODE_OUTPUT events emitted while the WebSocket was between card v1 and card v2 are **lost** at the broadcast layer for card v2. Recovery has exactly two sources:

1. **JSONL** — reliable for *committed* turns (modulo E1's small flush race for the most recent one).
2. **Live wire from card v2's connect time forward** — reliable while v2 is connected.

Neither source alone covers the disconnect-window in-flight turn. The combination requires that **tugcode emit the in-flight turn's content from its own `ActiveTurn` state** when card v2 sends `request_replay`, then continue forwarding live events. JSONL alone won't work (E1's race plus the delete window for events emitted after v1 disconnected but before reaching JSONL flush).

#### Experiment E4 — Drop audit {#e4-drop-audit}

**Question.** Across the full path (claude stdout → tugcode → tugcast → tugdeck reducer), where can a message be silently lost? For each potential drop point: what causes the drop, what's the recovery story, and what telemetry signals the drop?

**Why it matters.** The user's hard requirement: "We must NEVER drop a message on the floor — one way or another." This experiment maps the surface area before we design the durability story.

**Approach.** No automated harness — this is a structural code audit. Output is a written table.

For each layer, list:
- The buffer / queue / channel
- Its capacity
- The behavior on overflow (block, drop, error)
- The telemetry signal (lifecycle log, error frame) on overflow or close
- The recovery path (re-fetch via request_replay? re-emit? lost forever?)

**Layers to audit.**

1. **claude → tugcode**: claude's stdout pipe (OS-level, ~64KB on macOS), drained by tugcode's `stdoutDrain` task.
2. **tugcode internal**: `writeLine` to Bun.stdout. Synchronous; the question is whether tugcast's reader keeps up.
3. **tugcode → tugcast**: tugcode's stdout pipe, drained by tugcast's bridge.
4. **tugcast supervisor**: per-session queue (`LedgerEntry::queue`), bounded — what are its limits and overflow behavior?
5. **tugcast → WebSocket**: the WS sender. What if a client is slow / disconnected?
6. **WebSocket → tugdeck**: the WS receiver. Does the WS protocol guarantee delivery? What about lost frames?
7. **tugdeck FeedStore**: routing, filtering. Does it ever drop?
8. **tugdeck reducer**: the explicit drop branches (e.g. `assistant_text` in idle phase). Each drop is a deliberate choice; this audit catalogs them.

**Implementation location.** Output table in this plan section. Source for the table: a code-reading pass (Read + Grep) over the relevant files; no test runs needed.

**How I run it.** Sequential code reads + summarized findings.

**Verdict format.** A table in this section + a paragraph naming the gaps the design must close.

**Verdict — drop-point inventory complete.**

| # | Layer | Buffer / Channel | Capacity | Overflow behavior | Telemetry | Recovery |
|-|-|-|-|-|-|-|
| 1 | claude → tugcode (claude stdout pipe) | OS pipe | macOS default ~64 KB | claude blocks on write (TCP-style backpressure) | none from claude | drain catches up; no drops |
| 2 | tugcode internal `writeLine` → Bun.stdout | OS pipe to tugcast | macOS default ~64 KB | tugcode blocks on write (Bun.write awaits) | none | tugcast's reader keeps draining; backpressure transparent |
| 3 | tugcode → tugcast (tugcode stdout pipe) | OS pipe | macOS default ~64 KB | tugcode blocks on write | none | tugcast's bridge keeps draining |
| 4 | tugcast supervisor per-session queue | `BoundedQueue<Frame>` (`agent_supervisor.rs`) | **256** (`BOUNDED_QUEUE_CAP`) | overflow drops the new push, returns `QueuePush::Overflow` | `request_replay.skipped reason="spawning_queue_overflow"` (tracing::warn) | **NONE today** — verb is dropped; cold-boot transcript may show empty until next dispatch (e.g. another reload) |
| 5 | tugcast CODE_OUTPUT broadcast | `tokio::sync::broadcast` | **1024** (`CODE_BROADCAST_CAPACITY`) | existing subscribers get `RecvError::Lagged(N)` | router emits `lag_detected` + `lag_recovery` control frames | router's `LagPolicy::Replay` replays from `ReplayBuffer` (1000 frames) — **existing subscribers only**; fresh subscribers after disconnect-reconnect get nothing for the disconnect window (E3) |
| 6 | tugcast CODE_OUTPUT replay buffer | `ReplayBuffer` (router.rs) | **1000** frames, evicting FIFO | oldest frame evicted on push past capacity | none on eviction | covers replay-on-lag for existing subscribers; if eviction happens during a long lag, the lagged subscriber gets a partial replay (older frames already evicted) |
| 7 | WebSocket frame to tugdeck | TCP socket | TCP receive buffer (kernel) | TCP backpressure; both ends pace | none | TCP guarantees in-order delivery + no loss while connection is open. Disconnect = recovery via reconnect+`request_replay`. |
| 8 | tugdeck `FeedStore` filter | `acceptFrame` → router by `tug_session_id` | n/a (synchronous filter) | drop if filter rejects | none | n/a — the filter is the contract |
| 9 | tugdeck `frameToEvent` decoder | `KNOWN_CODE_OUTPUT_TYPES` allowlist | n/a | drop unknown event types | none on receiver side | n/a — silent drop; must update allowlist when adding new event types |
| 10 | tugdeck reducer drop branches | per-handler phase guards | n/a | drop event if phase doesn't match (e.g. `handleAssistantText` drops in idle) | optional `console.warn` in some handlers | n/a — the drop is intentional defense-in-depth, but during mid-turn reload these become real drops (E2 finding) |

**Identified gaps where messages can drop without recovery in the mid-turn-reload scenario:**

- **G1 (E1 race).** Tugcode reading JSONL right after `result` on stdout sees a 2-6ms incomplete window. Result: an "in-flight" turn that just finished may show empty assistant content if replay reads JSONL too eagerly. Recovery: read tugcode's own `ActiveTurn.partialText` for the in-flight turn instead of JSONL.
- **G2 (E3 broadcast drop).** CODE_OUTPUT events emitted during the disconnect window between card v1 leaving and card v2 connecting are not delivered to card v2 by the broadcast channel. Recovery: card v2 sends `request_replay`; tugcode replays from JSONL + ActiveTurn.
- **G3 (E2 reducer drop).** Live events for an in-flight turn that arrive at tugdeck while phase is `idle` (i.e., before `replay_started` and after `replay_complete`) are dropped by the reducer. Recovery: today, none — the events are silently lost. Design phase must either (a) gate the live emit so events arrive only within the bracket, (b) extend the reducer's phase allowlist for events keyed by `state.activeMsgId`, or (c) buffer & re-dispatch.
- **G4 (Spawning-queue overflow).** A user typing 256+ messages during the cold-boot Spawning window (claude not yet alive) overflows the supervisor's per-session queue. Today logs and drops. Recovery: re-issue. Likely not realistic in practice; document and move on.
- **G5 (broadcast lag with eviction).** A subscriber that lags long enough for the 1000-frame `ReplayBuffer` to evict gets a partial replay. Likely rare in practice (1000 frames is many turns of content) but possible under load. Recovery: nothing automatic.

**Design implications.** To satisfy "never drop a message" for the mid-turn reload case:

- **Tugcode is the source of truth for the in-flight turn**, not JSONL. Closes G1.
- **Card v2 fetching via `request_replay` is the recovery path** for events lost during the disconnect window. Closes G2 *if* tugcode's response includes the in-flight turn's content from its own state (i.e., closes G1's same fix).
- **The bracket must contain the live events for the in-flight turn**, OR the reducer must accept them outside the bracket. Closes G3. Probably the simplest fix is for tugcode to suppress live emit during runReplay's window for the in-flight turn, and emit a single coherent block for it inside the bracket. (This avoids the α suppression failure mode because tugcode's ActiveTurn state, not JSONL, drives the in-flight content emission.)
- **G4 (spawning-queue overflow) and G5 (replay-buffer eviction)** are accepted as out-of-scope for this plan. Both have telemetry; both are realistic only under pathological load.

#### What we know now {#what-we-know-now}

The four experiments together produce a coherent picture of where the mid-turn reload scenario fails today and what the design must do.

**The story in one paragraph.** Tugcode mints its own UUID for each in-flight turn, but claude writes JSONL using its own `message.id`. These IDs never match. When a user reloads mid-turn, three things happen concurrently: (i) tugcode keeps draining claude's stdout and emitting live events keyed by the tugcode UUID; (ii) tugdeck's WebSocket disconnects, so events emitted in that window are lost at the broadcast layer (E3); (iii) when card v2 reconnects and dispatches `request_replay`, tugcode reads the JSONL — but the JSONL is a few milliseconds behind claude's stdout (E1) and uses claude's `message.id` (E2 confirms divergence). The orphan-synthesis path then fabricates a `turn_complete{interrupted}` for the trailing turn. Live events for the same logical turn (with tugcode's UUID, different key) arrive outside the replay bracket and get dropped by the reducer's phase guards (E2, E4 G3). Net result: the in-flight turn appears as a phantom interrupted row in the transcript while claude is still happily streaming, and the user has lost their work as far as the UI is concerned.

**The fix shape, derived from the verdicts.** Four design commitments, each pinned by a specific experiment:

1. **Tugcode is the in-flight turn's source of truth.** When `request_replay` arrives, tugcode emits the in-flight turn's content from its own `ActiveTurn` state (`partialText`, `toolCallMap`, the user's stored prompt) — not from JSONL. Pins E1's race away. JSONL stays the source of truth for *committed* turns where the race is irrelevant.
2. **One stable id per turn, owned by Tug, persisted in the ledger.** _(Originally written as "live and replay agree on claude's `message.id`"; superseded 2026-05-05 by [DM07] / [Step 4](#step-4) after manual testing surfaced a canonicalization race.)_ Tugcast mints a `tug_turn_id` UUID at user-submission time and persists it to the new `turns` table in the existing `SessionLedger` sqlite database BEFORE forwarding the user_message to tugcode. The id is propagated to tugcode via the inbound envelope, used as `ActiveTurn.msgId`, emitted on every live wire frame, and read back from the ledger during `runReplay`. Claude's `message.id` is captured as a secondary `claude_message_id` field on the row when claude completes — used to look up content in JSONL during replay, never used as the reducer's key. The reducer's existing `msg_id` dedupe handles the merge for free, but the id is durable from the moment of submission, so the merge problem doesn't depend on a runtime canonicalization step. Pins E2's divergence away by making it structurally impossible.
3. **The translator skips orphan synthesis when tugcode signals the trailing turn is the live in-flight one.** No more `turn_complete{interrupted}` for a turn that's actually still streaming. The signal is a single flag passed from tugcode to the translator.
4. **Tugcode emits the in-flight turn's content as a coherent block inside the replay bracket.** During `runReplay`, tugcode holds back live emit for the in-flight turn (suppress flag on `ActiveTurn`) and emits one consolidated set of events from its own state at the right point in the bracket. After `replay_complete`, live emit resumes naturally. Pins E2's interleaving and E4's G3 drop away. **This is different from α** because the suppressed events are emitted from tugcode's own ActiveTurn state inside the bracket, not skipped entirely with the hope that JSONL has them later.

**What the front end does.** Front end sends `request_replay` on services construction (already shipped). Reducer accepts the bracket. With (1)–(4), the wire delivers a clean replay including the in-flight turn keyed by claude's `message.id`. After `replay_complete`, live events with the same `message.id` continue to flow into the same TurnEntry. Card observer renders. Done. **The front end is not doing more work — it's the back end's job to deliver a coherent stream, and the back end has the data it needs to do it.**

**Drop story for "never lose a message."** Per E4: G1, G2, G3 are all closed by the four design commitments above. G4 (Spawning-queue overflow at 256 buffered frames during cold-boot) and G5 (broadcast replay buffer eviction at 1000 frames) are accepted as pathological-load-only and remain documented with telemetry. The "never drop" requirement is satisfied for the mid-turn reload scenario.

#### Phase 0 deliverable {#phase-0-deliverable}

A single commit `tide(mid-turn): Phase 0 investigation — harnesses + verdicts`:

- Four harness scripts / tests added to the repo:
  - `tugcode/scripts/investigate-jsonl-flush-timing.ts` (E1 single-run)
  - `tugcode/scripts/run-e1-batch.ts` (E1 multi-run aggregator)
  - `tugcode/src/__tests__/replay-spawn-mid-turn.test.ts` (E2)
  - `tugrust/crates/tugcast/tests/e3_subscriber_buffering.rs` (E3)
- Trace / report files under `dash/tugplan-tide-mid-turn-replay-traces/`:
  - `e1-batch-run-{01..10}.json`, `e1-batch-summary.json`
- This plan section's verdicts filled in with the actual findings
- "What we know now" summary written

#### Phase 0 checkpoint {#phase-0-checkpoint}

- [x] E1 (JSONL flush timing) harness committed; 10-run trace captured; verdict written. **Race exists, mean 4.2ms.**
- [x] E2 (live/replay ordering) test committed; trace captured; verdict written. **msg_id divergence + reducer drop confirmed on the wire.**
- [x] E3 (tugcast buffering) test committed; three sub-tests passing; verdict written. **Disconnect-window frames lost at broadcast layer.**
- [x] E4 (drop audit) table committed; five gaps identified, three closed by Phase 1 design commitments, two accepted as pathological-load-only.
- [x] "What we know now" summary written.
- [x] All check commands green: `bun test` (tugcode + new E2 test), `cargo nextest run` (tugcast + new E3 test). _TS / lint not re-run for this commit since no production source changed; the harnesses live under `scripts/` and `tests/` and don't enter the production build graph._

---

### Specification {#specification}

> **Specification below describes the Steps 1–3 design (DM03 / DM04 / DM05 / DM06).** It shipped in commits `6fe7ee60`, `cafa0c39`, `e71d8590` and remains the live design until [Step 4](#step-4) lands. The retirement of [DM03] and [DM05] (see [DM07]) replaces the wire-shape sub-sections below — `tug_turn_id` becomes a new field on inbound `user_message`, `claude_message_id` becomes a new field on outbound `turn_complete` — and replaces the `liveInflightMsgId` / `skippedTrailingTurn` translator contract with a ledger-driven `runReplay` path. The `ActiveTurn`-shape and `emitInflightTurnFromActiveTurn` machinery from [DM04] / [DM06] survive into Step 4 with two changes: `msgId` returns to `readonly` (sourced from the inbound `tug_turn_id`); a sibling `claudeMessageId: string | null` field captures claude's id for the `turn_complete` payload. Read this section for the implemented-and-shipped state; read [Step 4](#step-4) for the target state.

#### Wire shape (Steps 1–3 — superseded by [Step 4](#step-4)) {#wire-shape}

The mid-turn replay rides the existing `CODE_OUTPUT` bracket: `replay_started` → per-turn events → `replay_complete`. **No new wire frames.** Reducer phases unchanged: `idle | submitting | awaiting_first_token | streaming | tool_work | awaiting_approval | replaying | errored`. **No new reducer phase.** The four design decisions ([DM03]–[DM06]) all live below the wire — they reshape what tugcode emits, not how tugdeck observes it.

#### `ActiveTurn` shape {#active-turn-shape}

Per [DM03], [DM04], [DM06], the `ActiveTurn` class in `tugcode/src/session.ts` adds three fields and one mutation point:

```ts
class ActiveTurn {
  /** Mutable until first stream event with `message.id` arrives,
   * then frozen. Pre-populated with a placeholder UUID at install
   * time so logs / EOF emit have something to show even if the
   * turn dies before any stream event arrives. */
  msgId: string;

  /** The user's prompt text, captured by handleUserMessage from
   * the inbound UserMessage. Source-of-truth for the in-flight
   * turn's user_message_replay payload during runReplay (DM04). */
  readonly userText: string;

  /** Attachments captured by handleUserMessage from the inbound
   * UserMessage. Threaded through to the synthesized
   * user_message_replay so attachment-bearing turns (file uploads
   * etc.) reconstruct faithfully on mid-turn replay. Empty array
   * when the user submitted plain text. */
  readonly userAttachments: ReadonlyArray<Attachment>;

  /** Accumulated assistant text — already exists. */
  partialText: string;

  /** Already exists. */
  gotResult: boolean;
  interrupted: boolean;
  rev: number;
  seq: number;
  completion: Promise<void>;

  /** Set by runReplay when it adopts this turn for in-flight
   * emission (DM06). While true, dispatchEventToTurn and
   * signalEofToActiveTurn skip their per-turn writeLine calls
   * but continue to update state. Cleared by runReplay after
   * replay_complete is on the wire. */
  suppressEmit: boolean;
}
```

#### `runReplay` flow {#run-replay-flow}

```ts
async runReplay(): Promise<void> {
  if (sessionMode !== "resume") return;
  if (replayActive) {
    logReplay("request_dropped", { reason: "replay_in_flight" });
    return;
  }
  replayActive = true;

  // Snapshot the active turn at entry; nothing else can install one
  // synchronously and the synchronous block from here through the
  // first await runs in one tick.
  const inflight = (
    activeTurn !== null &&
    !activeTurn.gotResult &&
    !activeTurn.interrupted
  ) ? activeTurn : null;
  if (inflight !== null) inflight.suppressEmit = true;

  try {
    writeLine({ type: "replay_started", ipc_version: 2 });

    // Translator emits committed turns from JSONL. Trailing in-flight
    // turn is skipped iff its claude message.id matches inflight.msgId
    // (DM05).
    const translatorOpts: TranslateSessionOptions = {
      liveInflightMsgId: inflight?.msgId ?? undefined,
    };
    for await (const ev of translateJsonlSession(jsonl, translatorOpts)) {
      writeLine(ev);
    }

    // Emit the in-flight turn from ActiveTurn state (DM04). Skipped
    // when no in-flight turn exists or when the JSONL didn't end
    // with a turn matching it (the translator already emitted a
    // complete turn for this id; tugcode's emit would duplicate).
    if (inflight !== null && translatorTrailingTurnSkipped) {
      emitInflightTurnFromActiveTurn(inflight);
    }

    writeLine({ type: "replay_complete", count, ipc_version: 2 });
  } finally {
    replayActive = false;
    if (inflight !== null) inflight.suppressEmit = false;
  }
}
```

The `translatorTrailingTurnSkipped` signal is a small post-condition on the translator's iterator (e.g., a sentinel value or a flag returned alongside the count). Implementation detail; pinned in Step 2.

#### `emitInflightTurnFromActiveTurn` shape {#emit-inflight}

```ts
function emitInflightTurnFromActiveTurn(turn: ActiveTurn): void {
  // user_message_replay: synthetic but keyed by claude's msg_id
  // (DM03), with the user's prompt text and attachments from
  // ActiveTurn (DM04).
  writeLine({
    type: "user_message_replay",
    msg_id: turn.msgId,
    text: turn.userText,
    attachments: turn.userAttachments,
    ipc_version: 2,
  });

  // assistant_text: the partial accumulated so far. is_partial=false
  // marks "this is the latest authoritative text" so the reducer's
  // accumulator replaces rather than appends. After replay_complete
  // the drain's live emits resume with their natural is_partial: true
  // delta pattern, appending to scratch from this baseline. Allocate
  // a fresh seq via this.nextSeq() rather than reusing turn.seq —
  // turn.seq is the user-message half's seq, allocated when the
  // ActiveTurn was installed; the assistant_text needs its own seq
  // to maintain the wire-side seq invariant (matches the existing
  // pattern at session.ts:2032 where the final assistant_text on
  // gotResult uses this.nextSeq()).
  if (turn.partialText.length > 0) {
    writeLine({
      type: "assistant_text",
      msg_id: turn.msgId,
      seq: this.nextSeq(),
      rev: turn.rev,
      text: turn.partialText,
      is_partial: false,
      status: "streaming",
      ipc_version: 2,
    });
  }

  // tool_use / tool_result: emitted from the per-turn tool-call
  // record kept by the drain. Implementation detail in Step 3 once
  // we read the exact shape of the drain's tool tracking.

  // Terminal event for already-finished turns. If the turn finished
  // (gotResult or interrupted) BEFORE runReplay's bracket completes
  // — typical scenario: claude crashed or stdout EOFed during the
  // suppressed window — the drain's signalEofToActiveTurn ran with
  // suppressEmit=true and skipped its writeLine but called
  // turn.finish(). Without an explicit terminal emit here, the
  // reducer's pendingUserMessage stays set and the TurnEntry never
  // commits. Emit the appropriate terminal event so the bracket
  // delivers a complete TurnEntry.
  if (turn.gotResult) {
    writeLine({
      type: "turn_complete",
      msg_id: turn.msgId,
      seq: this.nextSeq(),
      result: "success",
      ipc_version: 2,
    });
  } else if (turn.interrupted) {
    writeLine({
      type: "turn_cancelled",
      msg_id: turn.msgId,
      seq: this.nextSeq(),
      partial_result: turn.partialText || "User interrupted",
      ipc_version: 2,
    });
  }
  // Else: turn is still live; the drain's post-suppression live
  // emits will eventually carry the real turn_complete with its
  // own seq.
}
```

#### Translator option and "did-skip" reporting {#translator-option}

```ts
interface TranslateSessionOptions {
  // Existing options...

  /** When set, the translator's end-of-JSONL flush checks the
   * trailing turn's terminal assistant message.id. If it matches
   * liveInflightMsgId, the entire trailing turn (user + partial
   * assistant + tool entries) is skipped — tugcode's own emission
   * path covers it. Orphan synthesis is also skipped. When unset,
   * the existing behavior applies: trailing in-flight turns
   * orphan-synthesize a turn_complete{interrupted}. */
  liveInflightMsgId?: string;
}

/** Result returned by `translateJsonlSession` after the iterator
 * exits. The caller reads `skippedTrailingTurn` to decide whether
 * to emit the in-flight turn from ActiveTurn state (DM04).
 * `count` is the number of turn_complete events the translator
 * emitted, mirroring today's return shape. */
interface TranslateSessionResult {
  count: number;
  /** True iff `liveInflightMsgId` was set AND the JSONL's trailing
   * turn's assistant entry matched it AND the translator skipped
   * that turn's events. False in all other cases (no liveInflight
   * set, no trailing turn, trailing turn id didn't match, JSONL
   * empty/malformed). */
  skippedTrailingTurn: boolean;
}
```

**Reporting mechanism, pinned:** `translateJsonlSession` is changed from a bare `AsyncIterable<OutboundMessage>` to an async function that returns a `Promise<TranslateSessionResult>` *and* yields events through a callback (or a held generator's `.return()` value, depending on which fits cleanest at implementation time). `runReplay` reads `skippedTrailingTurn` after the iterator exits to decide whether to call `emitInflightTurnFromActiveTurn`.

The exact API shape — generator-with-final-value vs. callback-plus-promise — is a Step 2 implementation detail. The contract is fixed: **the translator MUST tell `runReplay` whether the trailing turn was skipped, before `runReplay` decides whether to emit from ActiveTurn.** Without this signal, `runReplay` would risk double-emitting the trailing turn (once from the translator, once from `emitInflightTurnFromActiveTurn`).

#### What stays the same {#unchanged}

- `request_replay` IPC verb ([D12] of resume plan).
- Reducer phases.
- `[D04]` msg_id dedupe — load-bearing for the merge once IDs agree.
- `[D08]` orphan synthesis — preserved for cold-boot interrupted-session JSONLs.
- All wire frames, all event types.

---

### Tuglaws Cross-Check {#tuglaws-cross-check}

The work touches tugcode (TypeScript bridge subprocess) and the translator. **No tugdeck changes.** No React, no responder chain, no token system, no list-view. The relevant laws:

- **L02** (External state enters React through useSyncExternalStore only) — N/A. Reducer is unchanged; the wire-shape is unchanged; tugdeck is a passive consumer.
- **L23** (Internal implementation operations must never lose user-visible state) — load-bearing. The whole plan exists to satisfy L23 for the mid-turn reload case. Pre-fix: in-flight turn is lost or shown as phantom interrupted. Post-fix: in-flight turn renders correctly with both halves of its content.
- **L24** (three-zone state partition) — N/A. No new state in tugdeck; tugcode-side state is per-process bridge state, outside the React zone model.

Cross-references to the resume plan's design decisions:

- **[D04]** msg_id dedupe at the reducer — relied on heavily. Once live and replay agree on `msg_id` (per [DM03]), the reducer's existing dedupe is the entire merge story.
- **[D08]** orphan synthesis — conditioned on `liveInflightMsgId` per [DM05]. Cold-boot path preserved.
- **[D12]** request-driven replay — unchanged; the verb is still the single trigger.

---

### Phase 1 — Implementation {#phase-1}

**Status:** Ready. Phase 0 closed; design pinned in [DM03]–[DM06]; spec written above.

Three execution steps + one close-out step. Each step ships a single commit, has failure-first proofs, and leaves the build green.

#### Step 1: Tugcode adopts claude's `message.id` as canonical for live events {#step-1}

**Commit:** `tugcode(mid-turn): canonicalize ActiveTurn.msgId from claude message.id`

**References:** [DM03], [E2 verdict](#e2-live-replay-ordering)

**Why this is Step 1.** The msg_id divergence is the load-bearing root cause. Every other step in this plan relies on live and replay events for the same logical turn agreeing on `msg_id`. Without this step first, [DM05]'s match (`liveInflightMsgId` against the JSONL's trailing turn id) cannot fire — the active turn's id wouldn't be claude's id.

**Artifacts:**

- `tugcode/src/session.ts` — `ActiveTurn.msgId` becomes mutable until first stream event with `message.id`, then frozen. `handleUserMessage` installs `ActiveTurn` with a placeholder UUID (so logs / EOF have something to show before claude responds). `dispatchEventToTurn` extracts `message.id` from the first stream event for the turn and overwrites `ActiveTurn.msgId`. The `EventMappingContext` passed into `routeTopLevelEvent` and `mapStreamEvent` then carries the canonical id.
- `tugcode/src/session.ts` — `mapStreamEvent` (currently at session.ts:697-770) gains a `message_start` branch that extracts `message.id` from `event.message.id` and exposes it via the existing `EventMappingResult` (or a sibling field on `routeTopLevelEvent`'s return). Today the function only handles `content_block_start` / `content_block_delta` / `tool_use` / `tool_result` and silently drops `message_start` — it must surface the id so `dispatchEventToTurn` can canonicalize.
- `tugcode/src/session.ts` — `routeTopLevelEvent` (currently at session.ts:351) gains the same id-extraction in its `case "assistant"` branch (session.ts:443) — read `(message?.id as string)` and surface it. Belt-and-suspenders: claude's stream-json with `--include-partial-messages` typically carries `message.id` in `message_start` BEFORE the top-level `assistant` snapshot, but the `assistant` snapshot also carries it; whichever lands first wins. Subsequent events with a matching id are no-ops; an event with a divergent id is logged and ignored (defensive — should not occur in practice for a single turn).
- `tugcode/src/session.ts` — `ActiveTurn` gains `userText: string` and `userAttachments: ReadonlyArray<Attachment>` per [#active-turn-shape]. `handleUserMessage` populates both from the inbound `UserMessage` before installing the active turn.
- `tugcode/src/__tests__/session.test.ts` (or `replay-spawn-drain.test.ts`) — new tests driving stream events with `message.id` (via `message_start`) and the top-level `assistant` event with `message.id`, asserting the active turn's `msgId` was overwritten in each case.

**Tasks:**

- [x] Read `dispatchEventToTurn` end-to-end. Identify the order in which `message_start`, top-level `assistant`, and the first emit-bearing event arrive. Confirm that no live emit fires before `message.id` is known (the first emit is for `content_block_delta`, which arrives after `message_start`).
- [x] Extend `mapStreamEvent` with a `message_start` branch that extracts `event.message.id` and threads it back through `EventMappingResult` (add a `messageId?: string` field).
- [x] Extend `routeTopLevelEvent`'s `case "assistant"` branch to read `(message?.id as string)` and surface it on `RouteResult` (add a `messageId?: string` field).
- [x] Add `userText: string` and `userAttachments: ReadonlyArray<Attachment>` to `ActiveTurn`. `Attachment` is already declared in `types.ts`.
- [x] Update `handleUserMessage` to populate `userText` from `msg.text` and `userAttachments` from `msg.attachments ?? []` before installing the active turn.
- [x] Implement the canonicalization in `dispatchEventToTurn`: after each call to `routeTopLevelEvent` / `mapStreamEvent`, check if the result surfaced a `messageId`. If so AND `turn.msgId` is still the placeholder, overwrite `turn.msgId`. Update `ctx.msgId` for any subsequent emits within the same dispatch tick so the FIRST emit (from the same event that carried the id) uses the canonical id.
- [x] Add tests as below.

**Tests:**

- [x] **Unit (msgId canonicalization via `message_start`)**: install an `ActiveTurn` with placeholder UUID `"placeholder-1"`. Drive a stream event of the form `{type: "stream_event", event: {type: "message_start", message: {id: "msg_claude_xyz", role: "assistant", ...}}}`. Assert `turn.msgId === "msg_claude_xyz"` after dispatch.
- [x] **Unit (msgId canonicalization via top-level `assistant`)**: same setup, but drive `{type: "assistant", message: {id: "msg_claude_abc", ...}}` instead. Assert `turn.msgId === "msg_claude_abc"`. Pins the belt-and-suspenders path for cases where `message_start` is absent.
- [x] **Unit (subsequent events keep the id)**: drive a second stream event for the same turn with the same `message.id`. Assert `turn.msgId` is still the captured value. Drive a third event with a *different* `message.id` (defensive check; shouldn't occur in production); assert tugcode keeps the first id captured and logs the divergence (no overwrite).
- [x] **Unit (`userText` + `userAttachments` populated)**: drive a `handleUserMessage({type: "user_message", text: "hello", attachments: [{filename: "f.txt", content: "...", media_type: "text/plain"}]})`. Read `(manager as any).activeTurn`. Assert `activeTurn.userText === "hello"` and `activeTurn.userAttachments.length === 1` with the right shape.
- [x] **Integration (live emit uses canonical id)**: drive a full turn through the drain (mock claude stdout feeding `message_start` → `content_block_delta` → ... → `result`). Assert every `assistant_text` / `turn_complete` IPC frame's `msg_id` matches claude's `message.id`, not the original placeholder UUID.
- [x] **Failure-first proof**: temporarily strip the canonicalization so `turn.msgId` stays the placeholder. Run the integration test. Assert it fails because emitted frames carry the placeholder UUID instead of claude's id. Restore. _Verified: 7 of 8 canonical tests fail with the canonicalization stripped (placeholder UUIDs leak into wire output); restored after verification._
- [x] **Regression (existing tests stay green)**: full `bun test` — `ActiveTurn.msgId`'s semantics change but its visibility doesn't; existing tests that observe emitted IPC frames pass because they read `msg_id` from the wire, not the construction-time UUID. _Verified: 291 / 291 tests pass post-implementation._

**Tuglaws cross-check:**

- N/A — tugcode bridge subprocess; no React; no tokens.

**Checkpoint:**

- [x] `bun test` (tugcode) — green. _291 / 291 pass._
- [x] `cargo nextest run` — green. _1221 / 1221 pass._
- [x] `just lint` — clean. _Auto-format applied to a pre-existing rustfmt issue in `e3_subscriber_buffering.rs` (Phase 0 file, not part of Step 1 logic) so the build stays green per the plan's strategy._

---

#### Step 2: Translator option to skip the live in-flight trailing turn {#step-2}

**Commit:** `tugcode(mid-turn): translator skips trailing turn on liveInflightMsgId match`

**Depends on:** [Step 1](#step-1)

**References:** [DM05], [D08] of the resume plan (orphan synthesis preserved for cold-boot)

**Artifacts:**

- `tugcode/src/replay.ts` — `TranslateSessionOptions` gains optional `liveInflightMsgId?: string`. The end-of-JSONL flush checks the trailing turn's terminal assistant entry's `message.id`. If it matches, skip the entire trailing turn (no `user_message_replay`, no per-turn assistant_text events, no orphan synthesis). The existing per-turn buffer detection is reused; the new branch is a single early-return inside the trailing-turn flush.
- `tugcode/src/replay.ts` — `translateJsonlSession` returns `TranslateSessionResult { count, skippedTrailingTurn }` per [#translator-option]. Today's API yields events through an async iterator; the `skippedTrailingTurn` value lands either as the iterator's `return` value (read via `iterator.next().value` after the iterator exits) OR via a callback on the options object — pick the cleaner shape at implementation time. `runReplay` reads `skippedTrailingTurn` in Step 3 to decide whether to emit the in-flight content from `ActiveTurn`.
- `tugcode/src/__tests__/replay.test.ts` — new tests for both branches (matched skip; unmatched orphan synthesis); plus a test that the returned `skippedTrailingTurn` accurately reports each branch's outcome.

**Tasks:**

- [x] Add `liveInflightMsgId?: string` to `TranslateSessionOptions`.
- [x] Update the trailing-turn flush branch: when `liveInflightMsgId` is set AND matches the trailing turn's id, skip everything for that turn.
- [x] Implement `TranslateSessionResult` per [#translator-option]. The contract is fixed: `skippedTrailingTurn` is `true` iff `liveInflightMsgId` was set, the JSONL had a trailing turn, AND the trailing turn's id matched. Otherwise `false`. _Implementation: AsyncGenerator's third type parameter (TReturn). `runReplay` reads it via `r.value` on the final `.next()` result; existing for-await call sites continue to work because they discard the return value. This is the cleanest pick — no callback indirection, no parallel promise — and it pins the contract at the type level._
- [x] Verify the cold-boot path is unaffected: existing tests with no `liveInflightMsgId` set must still synthesize the orphan `turn_complete{interrupted}`, and `skippedTrailingTurn` must be `false` for them.
- [x] Add tests as below.

**Tests:**

- [x] **Unit (skip on match)**: JSONL fixture with N committed turns + a trailing in-flight turn whose terminal assistant id is `"msg_X"`. Translator called with `liveInflightMsgId: "msg_X"` → emits the N committed turns and NOTHING for the trailing turn (no `user_message_replay`, no `assistant_text`, no `turn_complete`). `skippedTrailingTurn === true`.
- [x] **Unit (no skip on mismatch)**: same JSONL, called with `liveInflightMsgId: "msg_DIFFERENT"` → trailing turn emits with orphan synthesis as today. `skippedTrailingTurn === false`.
- [x] **Unit (cold-boot regression, no liveInflight)**: same JSONL, called with `liveInflightMsgId: undefined` → trailing turn orphan-synthesizes as today (preserves [D08] for the cold-boot interrupted-session case). `skippedTrailingTurn === false`.
- [x] **Unit (no trailing turn)**: JSONL with only completed turns (every assistant entry has `stop_reason`). Called with any `liveInflightMsgId` value → emits all turns normally. `skippedTrailingTurn === false`.
- [x] **Failure-first proof**: temporarily strip the early-return so the trailing turn always emits. Run the skip-on-match test. Assert it fails because the trailing turn's events appeared on the wire AND `skippedTrailingTurn` reports `false` (or whatever the buggy state produces — document the diagnostic shape). Restore. _Verified: with the skip path stripped, the skip-on-match test fails with `Expected length: 1, Received length: 2` (a duplicate `user_message_replay` for the trailing turn leaks through). Restored after verification._

Plus three additional pin tests landed alongside the five required ones: `missing JSONL with liveInflightMsgId still reports skippedTrailingTurn=false` (error-branch contract), `empty liveInflightMsgId is treated as unset` (defensive against placeholder-buffer collisions), and `for-await consumers cleanly ignore the return value` (backward-compat guard for pre-Step-2 call sites).

**Tuglaws cross-check:**

- N/A — pure TypeScript translator module; no React.

**Checkpoint:**

- [x] `bun test` (tugcode) — green. _298 / 298 pass; 7 new tests added in the trailing-turn-skip describe block._
- [x] `cargo nextest run` — green. _1221 / 1221 pass._
- [x] `just lint` — clean.

---

#### Step 3: tugcode emits in-flight turn from `ActiveTurn` during `runReplay` {#step-3}

**Commit:** `tugcode(mid-turn): emit in-flight turn from ActiveTurn; suppress live emit during replay window`

**Depends on:** [Step 1](#step-1), [Step 2](#step-2)

**References:** [DM04], [DM06], [E1 verdict](#e1-jsonl-flush-timing), [E2 verdict](#e2-live-replay-ordering)

**Artifacts:**

- `tugcode/src/session.ts` — `ActiveTurn.suppressEmit: boolean = false`. `dispatchEventToTurn` and `signalEofToActiveTurn` skip their per-turn `writeLine` calls when `suppressEmit` is true (state updates and `finish()` still run). The seven gating sites are documented in the `ActiveTurn` class doc.
- `tugcode/src/session.ts` — `runReplay` snapshots `this.activeTurn` at entry, treats it as an in-flight turn for defer purposes only when `!gotResult && !interrupted`. If matched: set `suppressEmit=true`, thread `liveInflightMsgId` into the translator, after the iterator completes call `emitInflightTurnFromActiveTurn(turn)` if the translator skipped the trailing turn, then emit `replay_complete`, then clear `suppressEmit` (`finally` guard).
- `tugcode/src/session.ts` — `emitInflightTurnFromActiveTurn` (private helper): emits the synthesized block per [#emit-inflight] — `user_message_replay` (with `msg_id = turn.msgId`, `text = turn.userText`, `attachments = turn.userAttachments`), then a consolidated `assistant_text { is_partial: false, text: turn.partialText }` with a fresh seq via `this.nextSeq()`, then per-turn tool events from the drain's per-turn tool record, then a terminal event (`turn_complete` if `gotResult`, `turn_cancelled` if `interrupted`, otherwise nothing — the live drain emits the real `turn_complete` post-bracket).
- `tugcode/src/__tests__/replay-spawn-mid-turn.test.ts` — extend the existing investigation test or write a new test: drive a full mid-turn replay scenario (active turn installed, runReplay called, then live drain emits more deltas + result). Assert the wire trace has exactly one bracket and one TurnEntry's worth of events for the in-flight turn, all keyed by claude's id.

**Tasks:**

- [x] Add `suppressEmit` field to `ActiveTurn` and gate the seven per-turn writeLine sites in `dispatchEventToTurn` (5) and `signalEofToActiveTurn` (2). _Sites enumerated in the `ActiveTurn.suppressEmit` doc-comment: routeResult.messages forwarding, streamResult.messages forwarding, control_request_forward, complete-text on gotResult, turn_complete on gotResult, EOF turn_cancelled, EOF error._
- [x] Update `runReplay` per the spec section above. The defer branch is **NOT** the α "wait for completion" pattern — it sets `suppressEmit`, runs replay, emits the in-flight block, and clears suppress. No await on `activeTurn.completion`. _Buffered-replay_complete pattern: runReplay holds back the translator's terminal `replay_complete`, calls `emitInflightTurnFromActiveTurn` if `skippedTrailingTurn===true`, then emits the buffered close to preserve chronological wire ordering [committed, in-flight, replay_complete]._
- [x] Implement `emitInflightTurnFromActiveTurn` per [#emit-inflight]. Allocate fresh seqs via `this.nextSeq()` for the assistant_text and any terminal event. Handle the `gotResult` and `interrupted` branches per the [DM06] crash-during-suppression pitfall.
- [x] Read the drain's tool-call tracking and decide whether to thread tool events through `emitInflightTurnFromActiveTurn` now or defer to a follow-on. _Deferred: the drain dispatches tool events through writeLine without buffering per-turn tool state, so we have no record to replay. Documented in the helper's doc-comment as a known v1 limitation. A tool-approval that lands mid-window is rare given the bracket's tens-of-ms window; deferred to roadmap follow-on (mid-tool-use reload)._
- [x] Verify the post-suppression live emit picks up cleanly. Add an inline comment in `mapStreamEvent`'s `content_block_delta` branch noting that the **delta-only** emission shape (`text: delta.text`, `is_partial: true`) is load-bearing for Step 3's "snapshot then resume" pattern: the synthesized `is_partial: false` snapshot REPLACES the reducer's scratch, and subsequent live deltas APPEND to it. If a future change makes `mapStreamEvent` emit cumulative text instead of deltas, mid-turn replay's resume would double-count and Step 3's integration test would fail. The comment is the canary.
- [x] Add tests as below.

**Tests:**

- [x] **Unit (suppress gates emit but not state)**: with `suppressEmit=true`, drive a stream_event delta and a result event. Assert no `assistant_text` / `turn_complete` IPC frames. Assert `partialText` accumulated and `gotResult=true`. _4 unit tests in session.test.ts: text-delta gating, result-event gating, suppress=false control, control_request_forward gating with pendingControlRequests still recorded._
- [x] **Unit (in-flight emission shape, still-live turn)**: install an active turn with `userText="hi"`, `userAttachments=[]`, `partialText="hello world"`, `msgId="msg_X"`, `gotResult=false`, `interrupted=false`. Call `emitInflightTurnFromActiveTurn`. Assert wire emits, in order: `user_message_replay { msg_id: "msg_X", text: "hi", attachments: [] }`, then `assistant_text { msg_id: "msg_X", text: "hello world", is_partial: false, seq: <fresh> }`. NO terminal event (`turn_complete` / `turn_cancelled`) — the live drain emits the real one post-bracket.
- [x] **Unit (in-flight emission with attachments)**: same setup but `userAttachments=[{filename: "f.txt", content: "...", media_type: "text/plain"}]`. Assert the emitted `user_message_replay` carries the attachment array verbatim.
- [x] **Unit (in-flight emission, gotResult-true)**: install an active turn with `gotResult=true`. Call `emitInflightTurnFromActiveTurn`. Assert wire emits include a `turn_complete { msg_id: "msg_X", result: "success", seq: <fresh> }` after the assistant_text. Pins the [DM06] crash-during-suppression mitigation for the success branch.
- [x] **Unit (in-flight emission, interrupted-true)**: install an active turn with `interrupted=true`. Assert wire emits include a `turn_cancelled { msg_id: "msg_X", partial_result: <text>, seq: <fresh> }` after the assistant_text. _Plus three additional pins: `signalEofToActiveTurn` honors suppressEmit on interrupted/unfinished turns; empty-partialText skips assistant_text; gotResult precedence over interrupted._
- [x] **Integration (full Smoke D, still-streaming turn)**: install active turn for a partial stream; call runReplay; drive more deltas via the mock claude stdout post-suppression; let the turn complete with a `result` event. Assert the final wire trace has exactly one bracket and exactly one TurnEntry's worth of events for the in-flight turn, all keyed by claude's id. The reducer's scratch ends as `<snapshot text>` + `<post-bracket deltas>` with no double-counting.
- [x] **Integration (claude crashes during suppressed window)**: install active turn; call runReplay; mid-iteration, close the mock claude stdout (simulating EOF). Assert: `signalEofToActiveTurn` runs but its writeLine is gated; `runReplay` proceeds to emit the synthesized block; the synthesized block includes a terminal event because `turn.interrupted` was set by the EOF path or `turn.gotResult` was set if claude completed before EOF. Assert the reducer commits one TurnEntry rather than dangling. _Deterministic timing for "EOF mid-suppress" is hard to script in Bun's microtask model; the unit-test branches (gotResult/interrupted terminal events on emit-inflight, signalEofToActiveTurn honors suppress) cover the logic. Plus an integration test for the still-live ordering pin and an integration test for "post-bracket live deltas land normally" backstop the suppress lifecycle._
- [x] **Integration (no active turn → no in-flight emission)**: regression-pin existing cold-boot replay path. Call runReplay with no active turn; assert no `emitInflightTurnFromActiveTurn` invocation; trailing-turn orphan synthesis fires as today.
- [x] **Failure-first proof (suppress gate)**: temporarily revert the `suppressEmit` checks so live events leak during the window. Run the integration test. Assert it fails because live deltas appear before/inside the bracket alongside the in-flight emission. Restore. _Verified: stripping the `if (!turn.suppressEmit)` guards (replace_all) breaks 2 of 4 suppress-gate unit tests with `Received length: 1` (cost_update / turn_complete leaked). Restored._
- [x] **Failure-first proof (in-flight emission)**: temporarily revert the `emitInflightTurnFromActiveTurn` call. Run the integration test. Assert it fails because the in-flight turn's user/assistant events are absent from the bracket. Restore. _Verified: stripping the call breaks both Smoke D integration tests (in-flight events absent). Restored._
- [x] **Failure-first proof (terminal event on crash)**: with the gotResult-true unit test, temporarily strip the terminal-event branches. Run the test. Assert it fails because no `turn_complete` was emitted. Restore. _Verified: stripping the gotResult/interrupted branches breaks 4 of 7 emit-inflight unit tests (gotResult, interrupted, interrupted-empty, gotResult-precedence). Restored._

**Tuglaws cross-check:**

- N/A — tugcode bridge subprocess; no React.

**Checkpoint:**

- [x] `bun test` (tugcode) — green; failure-first proofs both produce sensible diagnostics. _316 / 316 pass; 18 new tests added (13 in session.test.ts, 5 in replay-spawn-mid-turn.test.ts)._
- [x] `cargo nextest run` — green. _1221 / 1221 pass._
- [x] `just lint` — clean.

Workspace-wide regression check: `bun test` from repo root — 3365 / 3365 pass (was 3347 pre-Step-3, +18 new).

---

#### Step 4: Ledger-authoritative turn ids — `SessionLedger.turns` table, single-id design {#step-4}

**Decision:** [DM07].

**Supersedes:** [DM03], [DM05]. Reverts the canonicalization plumbing introduced in [Step 1](#step-1) and the id-match plumbing introduced in [Step 2](#step-2). Preserves the `ActiveTurn` machinery from [Step 3](#step-3) (suppressEmit + emitInflightTurnFromActiveTurn) — those primitives stay; their inputs change.

**References:** [DM07]; [E1 verdict](#e1-jsonl-flush-timing); [E2 verdict](#e2-live-replay-ordering); [E3 verdict](#e3-tugcast-buffering); [E4 drop audit](#e4-drop-audit); manual-test bug surfaced 2026-05-05.

##### Why this Step exists {#step-4-why}

Two converging signals:

1. **The user-reported bug from manual testing 2026-05-05.** Submit a request, immediately `Developer > Reload` while the turn is in flight. The user submission disappears and the streaming response never appears — until a *second* reload. Root cause is the [DM03] canonicalization race: `ActiveTurn.msgId` is a placeholder UUID at install time and is canonicalized to claude's `message.id` only when `message_start` arrives. `request_replay` arriving in that window passes a placeholder UUID as `liveInflightMsgId`, the translator's [DM05] match check fails, and `runReplay`'s emit gate (`if (inflight && skippedTrailingTurn)`) prevents `emitInflightTurnFromActiveTurn` from firing. Live deltas post-bracket land while the reducer is in `idle` and get dropped per [E4 G3]. On the second reload, claude has finished, `activeTurn` is null at `runReplay` entry, JSONL has the complete turn, the translator's normal path emits everything.

2. **The user's stated product direction.** "Doing a great job of managing the transcript *is what this app does*." Stable identity per turn — across reload, across tugcode restart, across tugcode crash — is foundational to the transcript-management features on the roadmap (scroll-restore, turn references, sharing, edit-previous-turn, diff). A "two id schemes coexist" partition (the rejected Step 3.5 design) was unstable across reload and traded a real product-direction need for a debugging-grep convenience.

[DM03]'s framing — "structural cleanness" of canonicalizing live to claude's id — was illusory: the only place we merge live and replay is the mid-turn case in this plan, and the canonicalization race introduced its own bug class. The right move is to put per-turn identity where it belongs — in our own durable ledger — and use the ledger's id end-to-end. JSONL becomes a content-extraction source for the assistant text and tool calls of completed turns; the ledger is the identity authority.

##### Why `SessionLedger`, not tugbank {#step-4-why-ledger}

Reading `tugbank-core/src/lib.rs` confirms tugbank is explicitly authored as a *"SQLite-backed typed defaults store"* modeled after Apple's `UserDefaults` — domain-keyed, generation-counter-based for CAS settings writes, designed for "my preferences are these typed values." Per-turn write-heavy live-data flow is the wrong fit; using tugbank for it would misuse the abstraction.

`tugcast/src/session_ledger.rs` is already a per-session sqlite store with the right primitives:
- `rusqlite` 0.32, WAL mode, `busy_timeout=5000ms`, `synchronous=NORMAL`.
- One `Mutex<Connection>` per ledger instance; all writes serialize through it.
- Idempotent schema bootstrap (`CREATE TABLE IF NOT EXISTS`).
- Owned by the tugcast supervisor via the `SessionRecorder` trait (`LedgerSessionRecorder` is the production impl).
- Default path: `~/Library/Application Support/Tug/sessions.db` (macOS) / `$XDG_DATA_HOME/tugcast/sessions.db` (Linux).

Adding a `turns` table alongside `sessions` is the cheapest move that gets us a stable, durable, per-turn identity authority. Same crate, same database file, same writer.

##### Architecture summary {#step-4-architecture}

```
                                                    +------------------+
                                                    |   sessions.db    |
                                                    |  (sqlite, WAL)   |
                                                    |                  |
                                                    |  sessions   ←→ existing
                                                    |  turns      ←─ NEW (Step 4.1)
                                                    |  migrations ←─ NEW (Step 4.1)
                                                    +--------+--+------+
                                                       writer^  ^reader
                                                             |  |
   tugdeck                tugcast                   tugcode  |  |
     |  user_message        |  intercept user_message: mint  |  |
     |───────────────────→  |  tug_turn_id, INSERT turns ─┐  |  |
     |                      |  forward user_message       └──┘  |
     |                      |    +tug_turn_id  ─────────→ tugcode reads tug_turn_id
     |                      |                              ActiveTurn.msgId = tug_turn_id
     |                      |                              writes to claude.stdin
     |                      |                              ...streams...
     |                      |  ←──── turn_complete         emits turn_complete with
     |                      |        +claude_message_id    msg_id=tug_turn_id +
     |                      |  intercept turn_complete:    claude_message_id
     |                      |  UPDATE turns ──────────┐    │
     |                      |  forward turn_complete  └────┘
     |  ←───────────────────|
     |                      |
     |  request_replay      |
     |───────────────────→  |  forward ──────────────────→ tugcode opens sessions.db
     |                      |                              READ-ONLY (Bun's bun:sqlite)
     |                      |                              SELECT turns ORDER BY ordinal
     |                      |                              for each row, emit replay
     |                      |                              events keyed by tug_turn_id;
     |                      |                              for pending row matching
     |                      |                              ActiveTurn, emit from
     |                      |                              ActiveTurn state.
     |                      |  ←────── replay events ─── tugcode emits
     |  ←───────────────────|
```

Single sqlite writer (tugcast). Single sqlite reader for replay (tugcode). Same database file. WAL mode supports the writer + reader pair without contention.

##### Resume / fork / continue semantics for `turns` rows {#step-4-resume-fork-continue}

The session_ledger today supports three "open an existing session" flows: `--resume <id>` (resume an existing session), `--continue` (resume the most-recent session), and `--fork-session` (branch from an existing session into a new claude_session_id). The new `turns` table needs a clear answer for each.

- **`--resume <id>` (existing session_id):** The session_id is the same as before. The `sessions` row already exists. The `turns` rows for this session_id already exist (or get bootstrapped on first open per Step 4.8). New submissions append rows with the next `ordinal`. **Behavior is straightforward — no schema change needed.**

- **`--continue` (most-recent session):** The supervisor resolves the most-recent session_id from the existing `sessions` index, then proceeds as `--resume`. **Same as resume — no schema change needed.**

- **`--fork-session` (new claude_session_id, branched from a parent):** Tugcast assigns a fresh session_id for the fork. The fork has no `sessions` row yet (gets created via `record_spawn`) and no `turns` rows. **The forked session starts with `turns` empty.** The parent's `turns` rows are NOT copied — they belong to the parent session_id. JSONL on disk for the fork starts blank; `bootstrap_turns_from_jsonl` finds nothing to bootstrap until the user's first new turn lands.

  **Implication for transcript display on a fresh fork:** the fork's transcript is empty until the user submits. If the user expects to see the parent's history in the fork's view, that's a separate UX layer that reads BOTH the parent's `turns` rows and the fork's `turns` rows and concatenates. Out of scope for Step 4; if the picker / fork UX wants this, it builds the join query against the existing `sessions` row's `parent_session_id` field (which doesn't exist today — would be a follow-on schema addition).

**Decision pinned:** Step 4 implements the conservative interpretation — each session_id has its own `turns` rows, no cross-session copying. Forks start empty. If a future fork-UX feature needs parent history visible in the fork's transcript, it adds a `parent_session_id` column to `sessions` and a UNION query in tugcode's `runReplay`. That's a focused follow-on with its own decision record, not scaffolding here.

##### Trade-off table — why the new design {#step-4-tradeoff}

| | Steps 1–3 (canonicalize live to claude's id; [DM03] / [DM05]) | Step 3.5 (rejected; UUID for live + claude id for historical) | **Step 4 (ledger-authoritative `tug_turn_id`)** |
|---|---|---|---|
| Race window | Placeholder UUID until `message_start`; reload there breaks | None (UUID frozen at install) | None (UUID minted by tugcast before forward) |
| Id stable across reload | Yes (claude's id persists) | **No** — UUID disappears on reload, turn re-keys to claude id | **Yes** — `tug_turn_id` lives in sqlite |
| Id stable across tugcode crash | Yes if claude responded | No | **Yes** — row persisted before forward to tugcode |
| Tugcode-crash-before-claude-responds | User submission lost | User submission lost | **User submission preserved** (`state: 'pending'` row) |
| Future scroll-restore / turn-reference / sharing / edit-previous-turn / diff | Works | **Breaks** (id changes across reload) | **Works** (`tug_turn_id` is durable) |
| Cross-source merge for any future feature | Already works (single id) | Would need UUID ↔ claude-id map | **Already works** (`tug_turn_id` everywhere; `claude_message_id` is informational) |
| Mid-turn merge mechanism | Reducer's id-keyed dedupe (couples to [DM03] race) | Translator + ActiveTurn (couples to [DM05] match) | **Ledger row is the identity; translator content-only; ActiveTurn for in-flight content** |
| Code complexity | Mutable `msgId`, `canonicalizeMsgId`, `messageId` fields, two extraction sites | Drops [DM03] plumbing; coexisting id schemes in reducer | Drops [DM03] plumbing; new sqlite table + supervisor intercepts; **one id everywhere** |
| Wire shape change | None | None | **`user_message`: +`tug_turn_id`; `turn_complete`: +`claude_message_id` (reducer ignores both)** |
| Operational story | Single-process | Single-process | Single-writer (tugcast) + single-reader (tugcode) on same sqlite via WAL |

The Step 4 column is the only one where the rightmost row of "stable identity" is `Yes` for all of: reload, tugcode crash, future-feature support. That's why we're paying for the schema change and the supervisor intercepts.

##### What from Steps 1–3 survives, and what gets reverted {#step-4-what-survives}

**Reverted:**
- [Step 1] all canonicalization plumbing — `ActiveTurn.msgId` mutability, `canonicalizeMsgId`, `EventMappingResult.messageId`, `TopLevelRoutingResult.messageId`, the `message_start` branch in `mapStreamEvent`, the id extraction in `routeTopLevelEvent`'s `case "assistant"`. `ActiveTurn.msgId` returns to `readonly`.
- [Step 2] `TranslateSessionOptions.liveInflightMsgId`, the trailing-turn skip logic, `TranslateSessionResult.skippedTrailingTurn`. The translator stops driving identity. The orphan-synthesis path stays for the cold-boot case where the ledger has no rows for the session (legacy / migration mid-flight).

**Survives:**
- [Step 1] `ActiveTurn.userText`, `ActiveTurn.userAttachments` — still populated by `handleUserMessage` and consumed by `emitInflightTurnFromActiveTurn`.
- [Step 3] `ActiveTurn.suppressEmit` and the seven gated `writeLine` sites — still load-bearing for keeping live drain emits off the wire during `runReplay`'s bracket window. The reducer's `replaying` phase still drops events outside the active-msg-id-set; suppression keeps those events from leaking and being lost.
- [Step 3] `emitInflightTurnFromActiveTurn` — same shape (`user_message_replay` + `assistant_text` + optional terminal). Inputs change: `turn.msgId` is now `tug_turn_id` (sourced from the inbound envelope) rather than canonicalized from claude's id.
- [Step 3] [DM06] crash-during-suppression mitigation — the `gotResult` / `interrupted` terminal-event branches in `emitInflightTurnFromActiveTurn` keep the bracket delivering a complete TurnEntry even when the drain dies mid-replay.

**Newly added:**
- `ActiveTurn.claudeMessageId: string | null` — captured from `message_start` (or the assistant snapshot's `message.id`) for inclusion in the outbound `turn_complete` frame's new `claude_message_id` field. The capture plumbing is similar in shape to [Step 1]'s `messageId` extraction, but the destination is informational (the ledger uses it for JSONL content lookup), not identity.

##### Substep overview {#step-4-substeps-overview}

Step 4 ships in 8 substeps. Each is a single coherent commit, each leaves the build green (warnings-as-errors), each has a failure-first proof for any new behavior the substep introduces.

| Substep | Topic | Touches | Commit message |
|---|---|---|---|
| 4.1 | Ledger schema + API | `tugcast` (Rust) | `tugcast(turns): SessionLedger gains turns table + CRUD API` |
| 4.2 | Wire shape additions | `tugcode/src/types.ts`, tugcast IPC types | `tide(turns): wire shape — tug_turn_id on UserMessage, claude_message_id on TurnComplete` |
| 4.3 | Tugcast write path: insert pending | `tugcast/src/feeds/agent_supervisor.rs` | `tugcast(turns): mint tug_turn_id, insert pending row, forward augmented user_message` |
| 4.4 | Tugcast write path: mark complete | `tugcast/src/feeds/agent_supervisor.rs` | `tugcast(turns): intercept turn_complete, update row with claude_message_id` |
| 4.5 | Tugcode adoption | `tugcode/src/session.ts` | `tugcode(turns): adopt tug_turn_id from envelope; revert DM03 canonicalization; capture claudeMessageId` |
| 4.6 | Ledger-driven replay | `tugcode/src/session.ts`, `tugcode/src/replay.ts` | `tugcode(turns): runReplay reads ledger; translator becomes content-only` |
| 4.7 | Crash recovery | `tugcast/src/feeds/agent_supervisor.rs`, `tugcast/src/session_ledger.rs` | `tugcast(turns): pending-row reconciliation on session resume` |
| 4.8 | Migration of existing sessions | `tugcast/src/session_ledger.rs` (new JSONL parser module) | `tugcast(turns): bootstrap turns rows for pre-existing sessions` |

Plus the rip-and-simplify remediation at [Step 5](#step-5) (introduced after Step 4's smoke test failed) and the close-out at [Step 6](#step-6) which retests Smoke D end-to-end against the post-remediation design.

---

##### Step 4.1: SessionLedger gains `turns` table + CRUD API {#step-4-1}

**Commit:** `tugcast(turns): SessionLedger gains turns table + CRUD API`

**Depends on:** none (foundation).

**Artifacts:**

- `tugrust/crates/tugcast/src/session_ledger.rs` — schema additions:

  ```sql
  -- New: per-turn rows. Cascade-on-Forget is delivered via the
  -- `turns_cascade_delete_on_session` trigger below rather than a FK
  -- REFERENCES clause. Authored with FK in the original Step 4.1 commit
  -- and revised in Step 4.3 once the architectural chicken-and-egg
  -- surfaced: `dispatch_one` inserts turns rows at user-message dispatch
  -- time, before the bridge's `session_init` populates the `sessions`
  -- row, so an INSERT-time FK check fails on every fresh session.
  CREATE TABLE IF NOT EXISTS turns (
      tug_turn_id        TEXT PRIMARY KEY,
      session_id         TEXT NOT NULL,
      ordinal            INTEGER NOT NULL,         -- monotonic per session
      claude_message_id  TEXT,                     -- nullable until claude completes
      user_text          TEXT NOT NULL,
      user_attachments   BLOB NOT NULL,            -- JSON array (serde_json)
      state              TEXT NOT NULL,            -- 'pending' | 'complete' | 'interrupted'
      partial_text       TEXT,                     -- optional snapshots for crash recovery (deferred to 4.7)
      created_at         INTEGER NOT NULL,
      completed_at       INTEGER
  );

  CREATE INDEX IF NOT EXISTS turns_session_ordinal
      ON turns(session_id, ordinal);

  CREATE INDEX IF NOT EXISTS turns_claude_message_id
      ON turns(claude_message_id);

  -- New: cascade Forget from sessions to turns via trigger. Same
  -- observable behavior as the original FK ON DELETE CASCADE — the
  -- existing forget / sweep_expired / evict_oldest_closed paths all
  -- DELETE FROM sessions, which fires this trigger.
  CREATE TRIGGER IF NOT EXISTS turns_cascade_delete_on_session
  AFTER DELETE ON sessions
  FOR EACH ROW
  BEGIN
      DELETE FROM turns WHERE session_id = OLD.session_id;
  END;

  -- New: schema versioning. v1 = sessions only. v2 = sessions + turns.
  CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
  );
  ```

  The `bootstrap_schema` fn applies the new tables idempotently and inserts a row into `migrations` for `version=2` via `INSERT OR IGNORE INTO migrations (version, applied_at) VALUES (2, ?)` so re-opening an already-v2 database doesn't double-insert (the PRIMARY KEY on `version` would otherwise reject the duplicate, but `OR IGNORE` is the right idiom for "schema-version markers"). v1 → v2 has no data to migrate at the SQL layer (existing `sessions` rows are unchanged); the JSONL-bootstrap migration lives in 4.8. The "open a v1 file, get a v2 file" path is exercised by the v1→v2 migration test in [#step-4-1]'s test list.

- `tugrust/crates/tugcast/src/session_ledger.rs` — new types:

  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum TurnState {
      Pending,
      Complete,
      Interrupted,
  }

  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  pub struct TurnRow {
      pub tug_turn_id: String,
      pub session_id: String,
      pub ordinal: i64,
      pub claude_message_id: Option<String>,
      pub user_text: String,
      pub user_attachments: Vec<serde_json::Value>,  // serialized to BLOB at write
      pub state: TurnState,
      pub partial_text: Option<String>,
      pub created_at: i64,
      pub completed_at: Option<i64>,
  }
  ```

- `tugrust/crates/tugcast/src/session_ledger.rs` — new methods on `SessionLedger`. All `#[allow(dead_code)]` until 4.3+ wire them up (mirrors the existing pattern).

  - `insert_pending_turn(session_id: &str, tug_turn_id: &str, user_text: &str, user_attachments: &[serde_json::Value], now: i64) -> Result<(), LedgerError>` — INSERT a row with `state='pending'`, `ordinal = (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM turns WHERE session_id = ?)`. Inside a single immediate transaction so the ordinal is race-free.
  - `mark_turn_complete(tug_turn_id: &str, claude_message_id: &str, completed_at: i64) -> Result<(), LedgerError>` — UPDATE `state='complete', claude_message_id=?, completed_at=?` WHERE the row is currently `pending`. NotFound if no row. InvalidState if the row is already `complete` or `interrupted` (defensive — see 4.4 for "what if turn_complete fires twice" handling).
  - `mark_turn_interrupted(tug_turn_id: &str, partial_text: Option<&str>, completed_at: i64) -> Result<(), LedgerError>` — UPDATE `state='interrupted', partial_text=?, completed_at=?` WHERE pending. Used by 4.7's crash-recovery and explicit user-interrupt paths.
  - `record_partial_text(tug_turn_id: &str, partial_text: &str) -> Result<(), LedgerError>` — UPDATE `partial_text=?` WHERE pending. Optional periodic snapshot for crash recovery; called from 4.7 if we wire it. Idempotent re-writes are fine.
  - `list_turns_for_session(session_id: &str) -> Result<Vec<TurnRow>, LedgerError>` — `SELECT … FROM turns WHERE session_id = ? ORDER BY ordinal ASC`. Used by tugcode's read-side in 4.6.
  - `get_turn(tug_turn_id: &str) -> Result<Option<TurnRow>, LedgerError>` — single-row lookup.
  - `get_turn_by_claude_message_id(claude_message_id: &str) -> Result<Option<TurnRow>, LedgerError>` — uses the `turns_claude_message_id` index. Used during migration in 4.8 for idempotency ("did we already mint a tug_turn_id for this claude_message_id?").

- `tugrust/crates/tugcast/src/session_ledger.rs` — new error variant:

  ```rust
  #[error("invalid turn state in row: {0}")]
  InvalidTurnState(String),
  ```

**Tasks:**

- [x] Author the schema additions in `bootstrap_schema`.
- [x] Author `TurnState` and `TurnRow` types.
- [x] Author the seven CRUD methods, each with `#[allow(dead_code)]`.
- [x] Wire `migrations` table writes in `bootstrap_schema` (insert v2 row idempotently).
- [x] Document the schema-versioning policy in the module doc comment ("v1 was sessions-only; v2 added turns + migrations table; subsequent variants must INSERT a row into migrations and update the docs").

**Tests:** (all in `tugrust/crates/tugcast/src/session_ledger.rs`'s existing `#[cfg(test)]` module)

- [x] **Schema bootstrap (fresh DB)**: open in-memory ledger; assert `sessions`, `turns`, and `migrations` tables exist; assert `migrations` has one row with `version=2`.
- [x] **Schema bootstrap (v1 → v2 migration on existing file)**: pre-create a sqlite file with ONLY the v1 schema (just the `sessions` table — no `turns`, no `migrations`); insert a few sessions rows directly; open the ledger via `SessionLedger::open`; assert (a) the `turns` and `migrations` tables now exist; (b) `migrations` has a single row with `version=2`; (c) the pre-existing `sessions` rows are preserved unchanged. Pins the in-place upgrade path that real users on existing tugbank databases will hit.
- [x] **Idempotent re-open**: open, close, re-open; assert no duplicate `migrations` rows (the v=2 row INSERT uses `INSERT OR IGNORE` keyed on `version`); assert `turns` table still exists with same shape.
- [x] **insert_pending_turn**: insert two turns into same session; assert ordinals are 0 and 1; assert state='pending'; assert claude_message_id is NULL.
- [x] **insert_pending_turn ordinal race**: two threads racing inserts on the same session; assert no duplicate ordinals (the immediate transaction guarantees this).
- [x] **mark_turn_complete**: insert pending, mark complete, assert state='complete', claude_message_id set, completed_at set.
- [x] **mark_turn_complete on already-complete row**: returns `InvalidTurnState`.
- [x] **mark_turn_complete on missing row**: returns `NotFound`.
- [x] **mark_turn_interrupted**: insert pending, mark interrupted with partial_text, assert state='interrupted', partial_text set.
- [x] **record_partial_text**: insert pending, write partial twice with different values, assert latest value persists.
- [x] **list_turns_for_session**: insert three turns out of ordinal order via direct SQL; assert list returns them in ordinal-ASC order.
- [x] **get_turn / get_turn_by_claude_message_id**: round-trip lookup.
- [x] **Cascade delete**: delete a session row; assert all its turns rows are gone.
- [x] **Failure-first proof**: temporarily strip the unique-by-session-ordinal logic from `insert_pending_turn`; run the ordinal-race test; assert duplicates surface.

**Tuglaws cross-check:**

- N/A — Rust crate; no React.

**Checkpoint:**

- [x] `cargo nextest run -p tugcast` — green.
- [x] `cargo clippy -p tugcast --all-targets -- -D warnings` — clean.
- [x] `cargo fmt --all -- --check` — clean.

---

##### Step 4.2: Wire shape — `tug_turn_id` on UserMessage, `claude_message_id` on TurnComplete {#step-4-2}

**Commit:** `tide(turns): wire shape — tug_turn_id on UserMessage, claude_message_id on TurnComplete`

**Depends on:** [Step 4.1](#step-4-1).

**Artifacts:**

- `tugcode/src/types.ts` — `UserMessage` (inbound) gains a `tug_turn_id?: string` field. Optional in the type so test fixtures and synthetic-input paths still compile; production tugcast always populates it. `TurnComplete` (outbound) gains a `claude_message_id?: string` field. **`TurnCancelled` (outbound) symmetrically gains a `claude_message_id?: string` field.** This lets tugcast's merger intercept (Step 4.4) record `claude_message_id` on the ledger row when the user explicitly cancels mid-stream — important because the row's `claude_message_id` is what `runReplay` uses to look up the partial assistant content from JSONL on the next reload. Without `claude_message_id` on `turn_cancelled`, an interrupted turn loses its partial-content backreference. All three fields are optional for the same backward-compat reason.
- `tugcode/src/types.ts` — type guards (`isUserMessage`, etc.) unchanged.
- `tugrust/crates/tugcast/src/feeds/code.rs` (or wherever the IPC envelope shape is encoded) — `UserMessage` envelope construction is updated to forward `tug_turn_id` to tugcode's stdin. `TurnComplete` and `TurnCancelled` parsing reads `claude_message_id` if present.
- Reducer / tugdeck — **no change.** The reducer keys by `msg_id` on the wire; the new fields are siblings the reducer ignores. Tugways / observers ignore them. This is a load-bearing decision — we're keeping reducer surface area unchanged.

**Tasks:**

- [x] Add `tug_turn_id?: string` to `UserMessage` in `tugcode/src/types.ts`.
- [x] Add `claude_message_id?: string` to `TurnComplete` in `tugcode/src/types.ts`.
- [x] Add `claude_message_id?: string` to `TurnCancelled` in `tugcode/src/types.ts`.
- [x] Update tugcast's IPC envelope serialization to thread these fields through (Rust side).
- [x] No changes in tugdeck. Verify with a build.

**Tests:**

- [x] **Type compile-check**: `bun x tsc --noEmit` passes with the new fields. (Implicit; covered by full-suite check.)
- [x] **Round-trip serialization (Rust)**: `UserMessage { tug_turn_id: Some("...") }` serializes / deserializes; same for `TurnComplete { claude_message_id: Some("...") }`.
- [x] **Backward-compat**: deserialize an envelope WITHOUT the new field; assert it parses with `tug_turn_id = None`. Pins the optional-field migration story.

**Tuglaws cross-check:**

- N/A — wire shape addition; no React state.

**Checkpoint:**

- [x] `bun x tsc --noEmit` — clean.
- [x] `cargo nextest run -p tugcast` — green.
- [x] `bun test` (tugcode) — green (no behavior change yet; the new field is unread).

---

##### Step 4.3: Tugcast intercepts inbound `user_message` — mint `tug_turn_id`, INSERT pending row, forward augmented envelope {#step-4-3}

**Commit:** `tugcast(turns): mint tug_turn_id, insert pending row, forward augmented user_message`

**Depends on:** [Step 4.1](#step-4-1), [Step 4.2](#step-4-2).

**Artifacts:**

- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — `AgentSupervisor::dispatch_one` (the per-frame entry point at line ~2321) gains a type-aware interception step. The dispatcher today is **generic over `Frame`** — it parses `tug_session_id` from the payload, looks up the ledger entry, and routes by `SpawnState` (Idle / Spawning / Live / Errored / Closed). It does NOT currently parse the inner JSON `type` field. The intercept extends this:

  Implementation site, in order:

  1. After `parse_tug_session_id` (existing) and BEFORE the `entry_arc` lookup: also parse `frame.payload`'s `type` field (cheap — same JSON we already touched).
  2. If `type !== "user_message"`: continue with the existing routing logic, frame unchanged. (Other CODE_INPUT types — `tool_approval`, `interrupt`, `permission_mode`, `model_change`, `session_command`, `stop_task`, `request_replay` — pass through as today.)
  3. If `type === "user_message"`:
      a. Parse `text` and `attachments` from the payload (existing JSON we already have).
      b. Mint `tug_turn_id` via `uuid::Uuid::new_v4()`.
      c. Call `ledger.insert_pending_turn(session_id, &tug_turn_id, user_text, user_attachments, now())`.
      d. On `LedgerError`: emit a `code_error` frame to `control_tx` (matches existing `build_session_unknown_frame` / `build_backpressure_frame` pattern at line ~2342), drop the inbound frame, return early. **Do not forward to tugcode.** The user-visible behavior is identical to a backpressure error; tugdeck surfaces it through the existing error-frame path.
      e. On success: build a **new** `Frame` with the augmented payload (`Frame::payload` is `Bytes`, immutable in-place; we construct a fresh `Frame::new(FeedId::CODE_INPUT, augmented_payload_bytes)`), where the augmented payload is the original JSON with `tug_turn_id` added at the top level. Use `serde_json` to round-trip; the cost is negligible compared to the sqlite write we just did.
      f. Substitute the augmented frame for the original. Continue with the existing routing logic.
  4. The augmented frame proceeds through the unchanged `match entry.spawn_state` block. Critically: in **all three** branches that consume the frame — `Idle` (queue + spawn), `Spawning` (queue), `Live` (forward via `input_tx`) — the frame already carries `tug_turn_id`. Frames sitting in `entry.queue` waiting for the session to go live are baked with the id; when they drain at handshake completion, tugcode receives them already-augmented.

  This ordering is load-bearing: **row-persisted-before-frame-augmented-before-routed.** A failure between any of (a)…(f) leaves the system in a recoverable state — a `pending` row with no forwarded frame is reconciled to `interrupted` on session resume (Step 4.7); a forwarded augmented frame with no row is structurally impossible because the augmentation happens after the insert.

- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — the `SessionsRecorder` trait gains `insert_pending_turn(session_id: &str, tug_turn_id: &str, user_text: &str, user_attachments: &[serde_json::Value], now: i64) -> Result<(), LedgerError>` so the test injection seam works. (Note the existing trait is `SessionsRecorder` — plural — at `agent_supervisor.rs:490`, NOT `SessionRecorder`. Authors have written this consistently as plural; the new method joins the existing 8 methods on the trait.)

**Tasks:**

- [x] Author a `payload_inspector` module that exposes a partial-shape `serde_json` struct for reading the `type` field (and other top-level fields like `tug_turn_id`, `msg_id`, `claude_message_id`) from a `Frame::payload`. Reused by 4.3's inbound parse and 4.4's outbound parse.
- [x] Extend `AgentSupervisor::dispatch_one` per [#step-4-3]'s artifact spec: parse `type`, branch on `user_message`, mint + insert + augment + substitute.
- [x] Build the augmented payload via `serde_json::from_slice` → mutate `Map<String, Value>` → `serde_json::to_vec` → `Bytes::from`. Construct a fresh `Frame::new(FeedId::CODE_INPUT, augmented_bytes)` since `Frame::payload` is immutable.
- [x] Add error path: `LedgerError` → emit error frame on `control_tx`, drop the frame, return early.
- [x] Extend the `SessionsRecorder` trait (note: plural — line 490) with `insert_pending_turn`. Update `LedgerSessionsRecorder` and the test recorder/fakes.
- [x] Verify that frames sitting in `entry.queue` during `Spawning` state retain the augmentation when they drain at handshake completion (the `Frame` clone preserves payload bytes; this is a sanity check, not new code).
- [x] **Schema fix-up landed in this step** — replace the FK `REFERENCES sessions(session_id) ON DELETE CASCADE` with a `turns_cascade_delete_on_session` trigger. The FK was broken at the architectural level: `dispatch_one` inserts turns rows at user-message dispatch time, before the bridge's `session_init` populates the `sessions` row, so an INSERT-time FK check would chicken-and-egg on every fresh session. The trigger preserves the user-visible Forget cascade without coupling INSERT ordering across the dispatch and bridge code paths. Module doc comment for `session_ledger.rs` updated to explain the rationale; v=2 still applies.

**Tests:**

- [x] **Happy path**: feed a user_message into the supervisor; assert (a) ledger has a `pending` row with the user_text; (b) tugcode receives an envelope with `tug_turn_id` matching the row's id; (c) the row's `ordinal` is correct (0 for the first turn).
- [x] **Multi-turn ordinal**: feed three user_messages; assert ordinals are 0, 1, 2 in order.
- [x] **Ledger failure**: inject a `SessionRecorder` impl that returns `LedgerError::Sqlite` on insert; assert (a) tugcode does NOT receive a forward; (b) tugdeck receives an error frame.
- [x] **Concurrency**: two user_messages racing on the same session; assert two rows with distinct ordinals (no collision); assert tugcode receives both forwards in order.
- [x] **Failure-first proof**: temporarily move the `forward to tugcode` call BEFORE the `insert_pending_turn` call; run the ledger-failure test; assert it fails because tugcode received the forward but the row wasn't persisted (durability invariant violated). _(Implemented as the ledger-failure test's "queue is empty + no row" assertions plus a docstring explaining how the test would catch a forward-first regression — see `dispatch_user_message_ledger_failure_drops_frame_and_emits_error`.)_
- [x] **Non-user_message pass-through**: dispatch a `tool_approval` (or any non-user_message CODE_INPUT type); assert the ledger has no turns row, the queued frame carries no `tug_turn_id`, and the original payload is preserved unchanged.

**Tuglaws cross-check:**

- N/A — supervisor (Rust); no React.

**Checkpoint:**

- [x] `cargo nextest run -p tugcast` — green.
- [x] `cargo clippy -p tugcast --all-targets -- -D warnings` — clean.
- [x] `bun test` (tugcode) — green (tugcode still ignores the new field; behavior change comes in 4.5).

---

##### Step 4.4: Tugcast intercepts outbound `turn_complete` — mark row complete with `claude_message_id` {#step-4-4}

**Commit:** `tugcast(turns): intercept turn_complete, update row with claude_message_id`

**Depends on:** [Step 4.3](#step-4-3).

**Artifacts:**

- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — `AgentSupervisor::merger_task` (the per-bridge fan-in at line ~2431) gains a type-aware interception step. The merger today is **generic over `Frame`** — it forwards each per-session frame to `code_output_tx`, and additionally captures `system_metadata` for SESSION_METADATA broadcast. It does NOT currently parse the payload's `type` for any other purpose. The intercept extends this:

  Implementation site, in the `maybe_frame = streams.next()` branch at line ~2464, **after** the existing `code_output_tx.send(frame.clone())` and the `is_system_metadata` check, **before** the next select-loop iteration:

  1. Parse the frame's payload `type` field (cheap — `serde_json::from_slice` with a partial-shape struct that only reads `type`).
  2. If `type === "turn_complete"` AND `claude_message_id` is present on the payload AND `msg_id` is present:
      a. Read `tug_turn_id = payload.msg_id`, `claude_message_id = payload.claude_message_id`.
      b. Call `ledger.mark_turn_complete(&tug_turn_id, &claude_message_id, now())`.
      c. On success: emit a `tide::ledger::turn_completed` tracing line for telemetry.
      d. On `LedgerError::NotFound` or `InvalidTurnState`: log a `tracing::warn!` but **the frame has already been forwarded** (step "before" above). The wire is the source of truth for the live UI; the ledger lagging by one update is a telemetry signal, not a user-facing error.
  3. Same intercept also runs for `type === "turn_cancelled"` (post fix-7 below): call `ledger.mark_turn_interrupted(&tug_turn_id, partial_text_from_payload, now())` so user-driven cancels persist correctly. The supervisor distinguishes this from crash-driven `mark_turn_interrupted` calls in 4.7 because this path has the `tug_turn_id` and (when claude streamed) the `claude_message_id`.

  Forward-before-mutate ordering is deliberate: the wire-side broadcast is the user-visible signal and must not be delayed by a database write. The ledger-side update is best-effort telemetry from the user's perspective; it becomes load-bearing only on the next `runReplay`, by which time the write has long since committed.

  Same partial-shape struct is reusable for both `dispatch_one`'s inbound parse (Step 4.3) and the merger's outbound parse — author it once in a `payload_inspector` module.

- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — `SessionsRecorder` trait gains `mark_turn_complete(tug_turn_id: &str, claude_message_id: &str, now: i64) -> Result<(), LedgerError>` and `mark_turn_interrupted(tug_turn_id: &str, claude_message_id: Option<&str>, partial_text: Option<&str>, now: i64) -> Result<(), LedgerError>`. (The trait is `SessionsRecorder` — plural — at `agent_supervisor.rs:490`.)

- **Coexists with existing `record_turn(session_id)`.** The existing `record_turn` (line 499) increments `sessions.turn_count` and bumps `last_used_at`. It continues to fire per-turn on the same `turn_complete` event and is **not** replaced by `mark_turn_complete`. The two are complementary: `record_turn` updates the per-session counter the picker reads; `mark_turn_complete` updates the per-turn row tugcode reads during `runReplay`. Both calls happen in the merger's `turn_complete` branch.

**Tasks:**

- [x] Extend `AgentSupervisor::merger_task` per [#step-4-4]'s artifact spec: after the existing `code_output_tx.send(frame.clone())`, parse the payload `type` via `payload_inspector` (reused from 4.3), branch on `turn_complete` and `turn_cancelled`.
- [x] On `turn_complete` with `claude_message_id` present: call `mark_turn_complete`. On error: warn + continue (frame is already forwarded).
- [x] On `turn_cancelled` (post fix-7 wire-shape change): call `mark_turn_interrupted` with `partial_text` from payload. On error: warn + continue.
- [x] On `turn_complete` with `claude_message_id` missing: log a warn line `tide::ledger::turn_complete_missing_claude_id`; skip the ledger update; the row stays `pending` and gets reconciled on next session resume.
- [x] Verify that `record_turn` (existing `SessionsRecorder` method that bumps `sessions.turn_count`) **continues to fire** alongside `mark_turn_complete` — both are called for the same `turn_complete` event. _(Structural: `record_turn` is invoked from `agent_bridge.rs` on the `turn_complete` byte scan; `mark_turn_complete` is invoked from `apply_outbound_turn_intercept` in the merger. The two call sites are independent and both unchanged on the bridge side; merger doc comment notes the coexistence.)_
- [x] Extend `SessionsRecorder` (plural — line 490) with `mark_turn_complete` and `mark_turn_interrupted`. Update `LedgerSessionsRecorder` and test fakes.
- [x] **Schema/API fix-up landed in this step** — extend `SessionLedger.mark_turn_interrupted` with an `Option<&str>` `claude_message_id` parameter (COALESCE-written in the UPDATE so `None` preserves any existing value). Symmetric with `TurnCancelled.claude_message_id` on the wire so an interrupted turn can carry the back-reference into claude's JSONL for `runReplay`. Existing 4.1 tests updated; two new tests for the COALESCE behavior.

**Tests:**

- [x] **Happy path (post-4.5)**: feed a `turn_complete { msg_id: <tug_turn_id>, claude_message_id: <claude_id> }` frame from tugcode through the supervisor; assert (a) ledger row is `state='complete'`, `claude_message_id` set, `completed_at` set; (b) tugdeck receives the frame.
- [x] **NotFound row**: feed a `turn_complete` for a `tug_turn_id` that doesn't exist; assert (a) warn line emitted in tracing; (b) tugdeck still receives the frame.
- [x] **Already-complete row**: mark a row complete twice; assert second call returns `InvalidTurnState`; second forward still goes through.
- [x] **Missing `claude_message_id`**: feed a frame without the field; assert warn + forward (no ledger write).
- [x] **Turn cancelled with partial_result**: feed a `turn_cancelled { msg_id, claude_message_id, partial_result }`; assert ledger row is `state='interrupted'`, `claude_message_id` set, `partial_text` set, `completed_at` set.
- [x] **Unrelated types pass through**: feed an `assistant_text` frame; assert no ledger writes.
- [x] **Failure-first proof**: spin up a real `merger_task`, send a `turn_complete` for a non-existent row (NotFound case), assert the broadcast still receives the frame. If a future regression made `mark_turn_complete` blocking, this test would fail because the frame would never reach the broadcast — pins the warn-and-continue policy.

**Tuglaws cross-check:**

- N/A — supervisor (Rust); no React.

**Checkpoint:**

- [x] `cargo nextest run -p tugcast` — green.
- [x] `cargo clippy -p tugcast --all-targets -- -D warnings` — clean.

---

##### Step 4.5: Tugcode adopts `tug_turn_id` from envelope; reverts [DM03] canonicalization {#step-4-5}

**Commit:** `tugcode(turns): adopt tug_turn_id from envelope; revert DM03 canonicalization; capture claudeMessageId`

**Depends on:** [Step 4.2](#step-4-2), [Step 4.3](#step-4-3).

**Artifacts:**

- `tugcode/src/session.ts` — `ActiveTurn.msgId` reverts to `readonly`. `msgIdCanonicalized` field and `canonicalizeMsgId` method are removed.
- `tugcode/src/session.ts` — `EventMappingResult.messageId` and `TopLevelRoutingResult.messageId` removed. `mapStreamEvent`'s `message_start` branch no longer returns `messageId`. `routeTopLevelEvent`'s `case "assistant"` no longer extracts `message.id` for the canonical-id path.
- `tugcode/src/session.ts` — `dispatchEventToTurn` removes the canonicalize-after-route and canonicalize-after-stream blocks. `ctx.msgId = turn.msgId` at top, used unchanged.
- `tugcode/src/session.ts` — `ActiveTurn` gains a new field `claudeMessageId: string | null = null`. The same plumbing that surfaced `messageId` before is partially restored, but the destination is `turn.claudeMessageId` (informational, used for the outbound `turn_complete`'s `claude_message_id` field), not `turn.msgId` (canonical).

  Hooks:
  - `mapStreamEvent`'s `message_start` branch: extract `event.message.id` and write to `turn.claudeMessageId` (via a new optional output field on `EventMappingResult` that `dispatchEventToTurn` forwards to the turn). First-write-wins (defensive — ignore subsequent mismatches with a warn).
  - `routeTopLevelEvent`'s `case "assistant"`: same.
- `tugcode/src/session.ts` — `handleUserMessage` reads `msg.tug_turn_id`. If present, use it as the `ActiveTurn`'s `msgId`. If absent (test fixtures, synthetic input), fall back to `newMsgId()` for graceful degradation; production always has the field because tugcast always supplies it.
- `tugcode/src/session.ts` — `dispatchEventToTurn`'s `gotResult` branch emits `turn_complete` with the new `claude_message_id` field populated from `turn.claudeMessageId`.
- `tugcode/src/session.ts` — `signalEofToActiveTurn` emits `turn_cancelled` with `claude_message_id: turn.claudeMessageId ?? undefined` (matches `turn_complete`'s shape, per fix-7 in Step 4.2). The user-driven cancel path (the user clicks Stop while claude is streaming) now persists `claude_message_id` to the ledger row, so on next reload the partial assistant content is reachable from the JSONL via the row. This closes the gap where a user cancel would leave the row without a content backreference. The supervisor-driven crash-recovery path in Step 4.7 calls `mark_turn_interrupted` with `claude_message_id: None` because in that path the supervisor doesn't see claude's id — that's fine, the crash-recovery row is already lossy by definition.
- `tugcode/src/session.ts` — `emitInflightTurnFromActiveTurn`'s `turn_cancelled` branch (the [DM06] mitigation) ALSO populates `claude_message_id: turn.claudeMessageId ?? undefined`, for the same reason.

**Tasks:**

- [x] Revert `ActiveTurn.msgId` to `readonly`. Remove `msgIdCanonicalized` and `canonicalizeMsgId`.
- [x] Remove `messageId` from `EventMappingResult` and `TopLevelRoutingResult`.
- [x] Update `mapStreamEvent`: remove the canonical-id surfacing for `message_start`. Add a new field `claudeMessageId?: string` on `EventMappingResult` populated from `message_start`.
- [x] Update `routeTopLevelEvent`: same — `claudeMessageId?: string` on `TopLevelRoutingResult` populated from `case "assistant"`. Wire emits in the assistant branch (synthetic text + tool_use blocks) now key on `ctx.msgId` (the tug_turn_id) rather than claude's id.
- [x] Update `dispatchEventToTurn`: remove canonicalize-after-route and canonicalize-after-stream blocks. Add new logic that writes `turn.claudeMessageId` via `setClaudeMessageId(...)` (first-write-wins) from `routeResult.claudeMessageId` / `streamResult.claudeMessageId`.
- [x] Update `handleUserMessage`: read `msg.tug_turn_id`; pass to `ActiveTurn` constructor as `msgId`; fall back to `newMsgId()` if absent.
- [x] Update `dispatchEventToTurn`'s `gotResult` branch: emit `turn_complete` with `claude_message_id: turn.claudeMessageId ?? undefined` (encoded as a conditional spread so the field is omitted entirely when null, preserving back-compat for older readers).
- [x] Update `signalEofToActiveTurn`'s `turn_cancelled` branch and `emitInflightTurnFromActiveTurn`'s terminal branches: same conditional spread for `claude_message_id`.
- [x] Update obsolete Step 1 tests in `session.test.ts` per [#step-4-test-deltas].

**Tests:**

- [x] **Tug_turn_id from envelope**: drive `handleUserMessage({ tug_turn_id: "tug_X", ... })`; assert `(manager as any).activeTurn.msgId === "tug_X"`.
- [x] **Tug_turn_id absent fallback**: drive `handleUserMessage({ ... })` (no `tug_turn_id`); assert `activeTurn.msgId` is a UUID (production never hits this; pin the fallback for tests).
- [x] **claudeMessageId capture from message_start**: drive `message_start` with `message.id = "claude_X"`; assert `activeTurn.claudeMessageId === "claude_X"` and `activeTurn.msgId` unchanged.
- [x] **claudeMessageId capture from assistant snapshot**: drive top-level `assistant` with `message.id = "claude_Y"` (no preceding `message_start`); assert capture; assert wire emits within the snapshot use ctx.msgId not claude's id.
- [x] **claudeMessageId first-write-wins**: drive `message_start` with `claude_A`, then `assistant` with `claude_B`; assert `claudeMessageId === "claude_A"`; assert a warn line for the divergence.
- [x] **turn_complete carries claude_message_id**: full integration drive; assert the emitted `turn_complete` frame has `claude_message_id` matching what claude emitted.
- [x] **turn_complete claude_message_id absent if claude never emitted**: synthetic-only / no-assistant-content path; assert `turn_complete` is emitted (with msg_id = tug_turn_id) but `claude_message_id` is undefined.
- [x] **Regression**: full `bun test` — all surviving tests from Step 1 / 2 / 3 still pass (316 total, +1 from new fallback + missing-claude-id integration coverage).

**Test deltas in `session.test.ts` and `replay.test.ts` and `replay-spawn-mid-turn.test.ts`:** {#step-4-test-deltas}

Step 1's canonicalization tests are removed (the surface they tested no longer exists in this form):
- `mapStreamEvent surfaces messageId from message_start` (4 tests) — REMOVED. Replaced by `mapStreamEvent surfaces claudeMessageId from message_start` (informational-not-canonical assertion).
- `routeTopLevelEvent surfaces messageId from assistant snapshot` (5 tests) — REMOVED. Replaced by `routeTopLevelEvent surfaces claudeMessageId from assistant snapshot`.
- `dispatchEventToTurn canonicalizes ActiveTurn.msgId` (6 tests) — REMOVED. Replaced by `dispatchEventToTurn captures claudeMessageId on ActiveTurn` (3-4 tests covering the same code paths but asserting on `claudeMessageId`, not `msgId`).
- `handleUserMessage integration: live emits use canonical msg_id` (2 tests) — REMOVED. Replaced by `handleUserMessage integration: live emits use tug_turn_id from envelope`.

Tests that survive unchanged:
- `ActiveTurn carries userText and userAttachments after handleUserMessage` (2 tests).
- `ActiveTurn.suppressEmit gates dispatchEventToTurn` (4 tests).
- `signalEofToActiveTurn honors suppressEmit` (2 tests).
- `emitInflightTurnFromActiveTurn` shape (7 tests) — fixture's `msgId` is now the tug_turn_id, but the helper's behavior is identical.

**Tuglaws cross-check:**

- N/A — tugcode bridge subprocess; no React.

**Checkpoint:**

- [x] `bun test` (tugcode) — green (316 pass).
- [x] `cargo nextest run` — green (1272 pass).
- [x] `just lint` — clean.

---

##### Step 4.6: Ledger-driven `runReplay`; translator becomes content-only {#step-4-6}

**Commit:** `tugcode(turns): runReplay reads ledger; translator becomes content-only`

**Depends on:** [Step 4.5](#step-4-5).

**Artifacts:**

- `tugcode/src/session.ts` — `SessionManager` opens `~/Library/Application Support/Tug/sessions.db` (or platform equivalent) read-only via Bun's `bun:sqlite` **once at construction**, holding the connection for the lifetime of the manager. `runReplay` reuses the connection on every invocation. The path is resolved at the same site that resolves `claudeProjectsRoot` today; tests inject an override via constructor option.

  ```ts
  import { Database } from "bun:sqlite";
  // At SessionManager construction:
  //   this.sessionsDb = new Database(sessionsDbPath, { readonly: true });
  // At SessionManager.shutdown():
  //   this.sessionsDb.close();
  ```

  Connection reuse rationale: opens are cheap but each `runReplay` invocation is a hot path. Holding the connection avoids per-call open/close overhead and lets sqlite cache the prepared statement for the `SELECT * FROM turns WHERE session_id = ? ORDER BY ordinal ASC` query (the only query `runReplay` runs against `sessions.db`).

- **Cross-process WAL verification.** tugcast (Rust, rusqlite) is the writer; tugcode (TS, `bun:sqlite`) is the reader. They are separate OS processes sharing one sqlite file. WAL mode supports this directly — multiple readers + one writer on the same file with no contention — but cross-process WAL on macOS has historical sharp edges (file locking interactions, particular when one process opened the DB before the other applied `PRAGMA journal_mode = WAL`). **A concrete verification test is required in 4.6 before we trust the production path:**

  ```ts
  // verification test (cargo nextest + bun test, coordinated):
  // 1. Rust test opens sessions.db (writes a row with `tug_turn_id: "VERIFY"`)
  // 2. Bun test opens the SAME path read-only via bun:sqlite
  // 3. Bun test SELECTs by tug_turn_id, asserts the row is visible
  // 4. Rust test inserts a second row; Bun test re-queries; assert visible
  ```

  This pins the cross-process invariant. If it fails on any platform, the whole Step 4 architecture has to fall back to RPC-via-stdin (tugcast reads on tugcode's behalf), which is a larger redesign — so we run this test FIRST, before committing to the rest of 4.6.

- `tugcode/src/session.ts` — `runReplay`'s loop:
  1. Snapshot `inflight = activeTurn` (same `!gotResult && !interrupted` guard as today).
  2. If `inflight !== null`, set `inflight.suppressEmit = true`. (Same as Step 3.)
  3. Open `sessions.db` read-only. Read `SELECT * FROM turns WHERE session_id = ? ORDER BY ordinal ASC`.
  4. Emit `replay_started`.
  5. For each row:
     - if `state === 'complete'`:
       - Emit `user_message_replay { msg_id: row.tug_turn_id, text: row.user_text, attachments: row.user_attachments }`.
       - **If `row.claude_message_id` is non-null:** look up the corresponding turn content in JSONL via `extractTurnContent(jsonl, row.claude_message_id, row.tug_turn_id)`. Emit `tool_use` / `tool_result` / `thinking_text` / `assistant_text { is_partial: false, msg_id: row.tug_turn_id }` for the turn's content.
       - **Defensive: if `row.claude_message_id` is null** (shouldn't happen for `state === 'complete'` rows in practice, but the column allows null and a future bug or partial migration could land us here): emit a tracing warn `tide::replay::complete_row_missing_claude_id` with the `tug_turn_id`, skip content extraction (no `assistant_text` emitted), and proceed to `turn_complete` so the TurnEntry still commits with whatever user-side content the row has. Same defensive treatment for **multiple ledger rows with the same `claude_message_id`** (the index is non-unique by design — claude reuse would be pathological): take the latest (`ORDER BY ordinal DESC LIMIT 1`) and warn.
       - Emit `turn_complete { msg_id: row.tug_turn_id, result: 'success' }`.
     - if `state === 'interrupted'`:
       - Emit `user_message_replay`. If `row.claude_message_id` is non-null AND JSONL has content for it: emit the partial `assistant_text` from JSONL (gives us the streaming content the user saw before they cancelled). Else if `row.partial_text` is set: emit synthesized `assistant_text { text: row.partial_text, is_partial: false }`. Else: skip the assistant_text. Then emit `turn_cancelled { msg_id: row.tug_turn_id, partial_result: row.partial_text ?? "" }`.
     - if `state === 'pending'`:
       - if `inflight !== null && row.tug_turn_id === inflight.msgId`: call `emitInflightTurnFromActiveTurn(inflight)`. (Same Step 3 helper.) The pending row's content is in ActiveTurn; the row exists in the ledger as a durability anchor, but ActiveTurn has the live state.
       - else: this is a "pending" row from a prior session that's no longer live (tugcode crash recovery). Treat as interrupted: emit user_message_replay + (optional partial_text) + turn_cancelled. (Defer to [Step 4.7](#step-4-7)'s reconciliation; for now emit a defensive synthesis.)
  6. Emit `replay_complete { count: <number of rows emitted> }`.
  7. Clear `inflight.suppressEmit` in `finally`.

- `tugcode/src/replay.ts` — the JSONL translator's identity surface is removed:
  - `TranslateSessionOptions.liveInflightMsgId` — REMOVED.
  - `TranslateSessionResult.skippedTrailingTurn` — REMOVED.
  - The trailing-turn-skip logic in the end-of-iteration flush — REMOVED.
  - The orphan-synthesis path is preserved for the cold-boot case where the ledger has no rows for the session (legacy / migration mid-flight).

  The translator becomes a **content-extraction utility**. New entry point:

  ```ts
  /**
   * Iterate JSONL entries and yield the OutboundMessage content for the turn
   * whose terminal `assistant` entry has `message.id === claudeMessageId`.
   * Yields tool_use / tool_result / thinking_text / assistant_text for that
   * turn's content blocks. Does NOT yield user_message_replay or turn_complete
   * — runReplay synthesizes those keyed by tug_turn_id.
   */
  export function* extractTurnContent(
    jsonl: string,
    claudeMessageId: string,
    msgIdForOutput: string,  // = tug_turn_id; runReplay supplies this
  ): Generator<OutboundMessage>
  ```

  The implementation reuses the existing `handleAssistantEntry` / `flushTurn` logic but is parameterized to emit with a caller-supplied `msg_id`.

- `tugcode/src/__tests__/replay-spawn-mid-turn.test.ts` — fixture seeds the ledger (via a tugbank-test seam) and asserts ledger-driven replay output. The existing 6 tests are restructured to seed rows + assert wire output keyed by `tug_turn_id` (seeded in the test).

**Tasks:**

- [x] Add `bun:sqlite` import to `session.ts`. Add a constructor option `sessionsDbPath?: string | null` for test injection (passing `null` opts out of opening any DB; passing a path uses that file; omitting → use `defaultSessionsDbPath()`).
- [x] Implement the new `runReplay` loop per the spec above. Branch on `ledgerRows.length > 0` → ledger-driven; else cold-boot fallback to `translateJsonlSession`. Helpers: `readLedgerTurnsForSession`, `decodeUserAttachments`, `runLedgerDrivenReplay`, `closeSessionsDb`.
- [x] Refactor `replay.ts`'s translator into the new `extractTurnContent` shape. Remove `liveInflightMsgId` / `skippedTrailingTurn`. The cold-boot orphan-synthesis path is preserved by `translateJsonlSession` itself (which still handles the trailing-buffer flush at end of JSONL with the same `flushTurn(ctx, "error")` semantics) — `runReplay` falls through to `translateJsonlSession` when the ledger has no rows for the session, so no separate `extractOrphanTurn` function was needed.
- [x] Update `replay-spawn-mid-turn.test.ts` per [#step-4-test-deltas-replay].

**Test deltas in `replay-spawn-mid-turn.test.ts`:** {#step-4-test-deltas-replay}

- The test rig grows a "seed turns rows" helper that opens a temp sqlite file, writes the schema (or borrows the production bootstrap), inserts `turns` rows for the test fixture, and points `runReplay` at it via the constructor option.
- The Smoke D test seeds two rows (one complete with claude_message_id pointing at JSONL, one pending matching the surrogate ActiveTurn). Asserts the wire output: replay_started → committed turn (via JSONL content lookup) → in-flight emission (via ActiveTurn) → replay_complete.
- The [DM06] gotResult / interrupted mitigation tests: seed one pending row, install ActiveTurn with the same tug_turn_id, drive the suppressEmit setter hook to simulate mid-bracket completion. Same assertions as today; fixture wires through the ledger now.
- The "no active turn / cold-boot" test: ledger has the rows for a previously-interrupted session; assert the wire emits each row keyed by its tug_turn_id (state=interrupted → turn_cancelled).
- The "post-bracket live deltas" backstop: same as today, fixture seeded into ledger.

**Tests:**

- [x] **Cross-process WAL verification** (per [#step-4-6]'s artifact spec): bun:sqlite reader sees rows written by an external `sqlite3` CLI subprocess on the same `sessions.db` file, both at re-open time AND while a long-lived read-only handle is held open. Run-first gate landed in `sessions-db-cross-process.test.ts`; passes.
- [x] **Bug-scenario regression (manual reload symptom)**: ledger has one pending row matching the surrogate ActiveTurn; drive `runReplay`; assert wire emits `user_message_replay { msg_id: tug_turn_id, text }` (+ no `assistant_text` when partialText empty) + replay_complete. **The bug from 2026-05-05 is structurally impossible because tug_turn_id is stable from submission and the ledger has the row regardless of JSONL state.**
- [x] **Smoke D ordering**: ledger has two rows (one complete, one pending matching ActiveTurn); assert ordering [replay_started, committed turn events, in-flight emission, replay_complete] and `replay_complete.count` reflects only the committed turn (the pending in-flight didn't fire a terminal — still-live).
- [x] **Cold-boot no-rows path**: ledger has zero rows for the session; JSONL has content; assert `runReplay` falls back to JSONL-driven emit via `translateJsonlSession`'s orphan-synthesis (preserves [D08] equivalence).
- [x] **Stale pending row (crash recovery proxy)**: ledger has a pending row that no live ActiveTurn matches; assert `runReplay` emits user + optional partial + turn_cancelled (defensive synthesis until 4.7 lands the reconciliation).
- [x] **Defensive: complete row with null `claude_message_id`**: seed a `state='complete'` row with `claude_message_id: NULL`; assert `runReplay` warns + emits `user_message_replay` + `turn_complete` with no `assistant_text`. Pins the defensive code path so it can't silently regress.
- [x] **Defensive: duplicate `claude_message_id` across rows**: seed two `state='complete'` rows with the same `claude_message_id`. Drive `runReplay`; assert both rows emit terminals but the JSONL content lookup picks the latest by ordinal (the earlier row gets no `assistant_text`) and warns about the duplication.
- [x] **Invariant pin: one `msg_id` per logical turn on the wire**: drive Smoke D-shape replay; capture wire trace; assert `Set<msg_id>` across all frames is exactly `Set<tug_turn_id>` of the seeded ledger rows. Permanent regression pin against the whole class of "two ids for one turn" bugs that motivated Step 4.
- [x] **Full-suite regression**: 322 tugcode tests pass (was 316 pre-Step-4.6; the +6 covers the new ledger-driven mid-turn tests + the cross-process WAL gate + the extractTurnContent unit tests minus the obsolete trailing-skip suite).
- [x] **Failure-first proof**: encoded structurally — the bug-scenario regression test asserts wire emits keyed by `tug_turn_id` from a ledger row whose `claude_message_id` is `null`. If a future regression brought back `liveInflightMsgId` gating in the translator + runReplay's old emit predicate, the test would fail because the translator's logic doesn't see a ledger and would emit nothing for the pending row (no JSONL content for a turn that never streamed).

**Tuglaws cross-check:**

- N/A — tugcode bridge subprocess; no React. Reducer surface unchanged.

**Checkpoint:**

- [x] `bun test` (tugcode) — green (322 pass); bug-scenario regression test passes.
- [x] `cargo nextest run` — green (1272 pass).
- [x] `just lint` — clean.

---

##### Step 4.7: Crash recovery — pending rows reconciled on session resume {#step-4-7}

**Commit:** `tugcast(turns): pending-row reconciliation on session resume`

**Depends on:** [Step 4.6](#step-4-6).

**Artifacts:**

- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — on session resume (the `record_spawn` path or its equivalent), after the session row is upserted to `live`, sweep any `state='pending'` rows owned by this session that have no live ActiveTurn (they're orphans from a prior tugcode crash or a clean tugcode exit before claude responded).
- Reconciliation policy: orphan pending rows are marked `interrupted` with `partial_text=NULL` (we don't have the streamed content; the row's `user_text` survives).
- Tugcode's `runReplay` (already written in 4.6 to handle `state='interrupted'`) surfaces these rows as `turn_cancelled`.
- `tugrust/crates/tugcast/src/session_ledger.rs` — new method `reconcile_pending_for_session(session_id: &str, now: i64) -> Result<Vec<String>, LedgerError>` — UPDATEs all pending rows for the session to interrupted, returns the affected `tug_turn_id`s for telemetry.

**Optional (deferred to follow-on if not needed for v1):** periodic `partial_text` snapshots from tugcode → tugcast → `record_partial_text`. Adds a write per N stream events. Closes the gap where a crash-mid-stream loses the partial assistant text. Not required to fix the user-reported bug; defer unless dogfooding surfaces a need.

**Tasks:**

- [x] Author `reconcile_pending_for_session` in `session_ledger.rs` (UPDATEs all pending rows for the session to `interrupted`, returns the affected `tug_turn_id`s, preserves `claude_message_id` via COALESCE, sets `completed_at = now`, leaves `partial_text` NULL).
- [x] Extend `SessionsRecorder` trait with `reconcile_pending_for_session`; impl on `LedgerSessionsRecorder` (with one warn line per orphan for tracing), `NoopSessionsRecorder`, and the test `InsertFailingRecorder`.
- [x] Wire into the session-resume path: placed inside `do_spawn_session`'s eager-spawn block, **gated on `should_spawn` (i.e., the entry's `spawn_state` was `Idle`)**. Idle means no tugcode is currently bound to this session, so any pending rows are orphans from the prior tugcode. Critically, this runs BEFORE any `dispatch_one` user_message intercept can insert a new pending row, avoiding the chicken-and-egg where reconciliation would interrupt a turn that's just been submitted.
- [x] UX decision: tugcode's `runReplay` (4.6) reads the reconciled row's state and emits `turn_cancelled` with `partial_result: row.partial_text ?? ""` — empty string for these because reconciliation can't know the streamed content. The wire shape is unchanged from the existing `turn_cancelled`.
- [x] Optional: periodic partial_text snapshots — deferred; not required to fix the user-reported bug.

**Tests:**

- [x] **Reconciliation on resume**: seed two pending rows; spawn_session via CONTROL fires the eager-spawn block which reconciles. Assert both rows transition to `interrupted` with `partial_text=NULL`.
- [x] **Just-submitted user_message row not reconciled**: drive `spawn_session` + first `user_message` dispatch; assert the freshly-inserted pending row stays pending. Pins the `do_spawn_session`-not-`spawn_session_worker` placement choice — if reconciliation moved later in the spawn flow, this test would fail.
- [x] **Rebind to non-Idle session does not reconcile**: drive `spawn_session` twice; the second is a rebind that hits the `should_spawn=false` branch (entry already in Spawning) and skips reconciliation. Pending row representing the live in-flight turn survives. The "live tugcode" gate is structural via `should_spawn`.
- [x] **Per-orphan warn telemetry**: direct trait call returns the affected `tug_turn_id`s in ordinal order (the warn-loop in the impl reads from this vec); reconciled rows carry the new `completed_at`.
- [x] **Failure-first proof**: encoded structurally — the "just-submitted user_message row not reconciled" test would fail if reconciliation moved into `spawn_session_worker` (which fires AFTER `dispatch_one`'s pending-row insert). The placement comment in `do_spawn_session` documents the invariant explicitly.
- [x] Ledger-level tests (in `session_ledger.rs`): all-pending → all-interrupted; mixed-state set leaves complete/interrupted rows untouched; empty no-op fast path; unknown session id is no-op; existing `claude_message_id` preserved across reconciliation.

**Tuglaws cross-check:**

- N/A — supervisor (Rust); no React.

**Checkpoint:**

- [x] `cargo nextest run -p tugcast` — green (580 pass, +4 from Step 4.7).
- [x] `bun test` (tugcode) — green (322 pass; tugcode's `runReplay` already handles `state='interrupted'` from Step 4.6).
- [x] `just lint` — clean.

---

##### Step 4.8: Migration — bootstrap turns rows for pre-existing sessions {#step-4-8}

**Commit:** `tugcast(turns): bootstrap turns rows for pre-existing sessions`

**Depends on:** [Step 4.6](#step-4-6).

**Artifacts:**

- `tugrust/crates/tugcast/src/jsonl_reader.rs` — NEW module. A minimal JSONL parser sufficient for migration: walk a JSONL file line-by-line, identify per-turn boundaries (user entry → assistant entries with the same logical thread → terminal entry with `stop_reason: end_turn`), extract per-turn `user_text`, `user_attachments`, `claude_message_id`. Does NOT need to mirror the full TS translator's content logic — migration only needs identity + user submission.
- `tugrust/crates/tugcast/src/session_ledger.rs` — new method `bootstrap_turns_from_jsonl(session_id: &str, project_dir: &str, now: i64) -> Result<usize, LedgerError>` — scans the JSONL file for the session, mints a `tug_turn_id` per turn, bulk-inserts rows. **Idempotency:** the function first calls `list_turns_for_session(session_id)` and short-circuits with `Ok(0)` if any rows exist for the session. This is correct because bootstrap is an "all or nothing" operation per session (a partial bootstrap shouldn't happen — either the session has been migrated or it hasn't), and it handles the case where mid-turn JSONL entries have `claude_message_id: NULL` (which `get_turn_by_claude_message_id` cannot disambiguate). The earlier draft's "skip by `claude_message_id`" check is replaced by this whole-session gate. Also: `get_turn_by_claude_message_id` is retained on the ledger API for diagnostic / debugging use, but is no longer the migration's idempotency primitive.
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — call `bootstrap_turns_from_jsonl` lazily on session-open if `list_turns_for_session` returns empty (and JSONL exists). Cached per session — bootstrap runs at most once.

**Tasks:**

- [x] Author the minimal Rust JSONL parser in `jsonl_reader.rs`. Exposes `parse_turns_from_jsonl(jsonl) -> Vec<ParsedTurn>`. Scope: turn boundaries + per-turn `user_text`, `user_attachments` (image blocks preserved verbatim), `claude_message_id` (terminal assistant entry's `message.id`), state classification (`Complete` / `Interrupted`). Tool-result-only user entries treated as turn continuation. Trailing in-flight turn at EOF flushed as `Interrupted`. Malformed lines silently skipped (matches TS translator permissiveness).
- [x] Author `SessionLedger::bootstrap_turns_from_jsonl(session_id, project_dir, now) -> Result<usize, LedgerError>`. Idempotency gated on **whole-session** `list_turns_for_session` (not `get_turn_by_claude_message_id` — the earlier draft's check couldn't disambiguate mid-turn entries with `null`-id). Bulk-insert in a single immediate transaction; per-row state derived from the parser's `ParsedTurnState`. Missing JSONL → `Ok(0)` with a tracing line.
- [x] Extend `SessionsRecorder` trait + impls (Ledger, Noop, InsertFailingRecorder) with `bootstrap_turns_from_jsonl`.
- [x] Wire lazy invocation on session-open: in `do_spawn_session`'s eager-spawn block, **before** the reconcile sweep, call `bootstrap_turns_from_jsonl`. Same gate as reconcile (`should_spawn`/`Idle`-only) so a rebind to a still-live session never triggers bootstrap. Failure is non-fatal — falls back to cold-boot via JSONL translator on `runReplay`.
- [x] Tracing: `tide::ledger::bootstrap` emits per successful bootstrap with the row count; `tide::ledger::bootstrap_jsonl_missing` for the missing-JSONL no-op; the supervisor wraps a `supervisor.bootstrap_at_spawn` event around non-zero counts so the lifecycle log carries the timing.

**Tests:**

- [x] **Bootstrap a session with 5 historical turns**: JSONL fixture with 5 `user → assistant end_turn` pairs; assert 5 rows inserted with ordinals 0-4, claude_message_ids matching, state=Complete.
- [x] **Idempotent re-run**: second call returns `Ok(0)`; row count unchanged; pinned by the whole-session gate.
- [x] **Partial JSONL**: 3 complete + 1 trailing in-flight; assert 3 Complete + 1 Interrupted (with `claude_message_id` from the last assistant entry, `partial_text` NULL).
- [x] **Malformed JSONL line**: surrounding turns insert; the bad line is silently skipped (parser permissiveness).
- [x] **Missing JSONL**: `Ok(0)` with `bootstrap_jsonl_missing` tracing event; no rows inserted.
- [x] **Empty JSONL**: `Ok(0)`; no rows inserted.
- [x] **Attachments round-trip**: image blocks survive parser → serde_json BLOB → row read.
- [x] **Supervisor integration: fresh spawn bootstraps legacy JSONL**: drives `handle_control("spawn_session", …)` against a supervisor whose ledger is rooted at a tempdir; pre-seeds a JSONL fixture; asserts the eager-spawn block calls bootstrap and rows land in the ledger keyed by their tug_turn_ids.
- [x] **Supervisor integration: no JSONL → no rows**: pin so brand-new sessions can't accidentally synthesize rows.
- [x] **Parser unit tests** (in `jsonl_reader.rs`): empty input, single complete turn, multi-turn, intermediate `tool_use` then terminal `end_turn`, trailing in-flight at EOF, back-to-back user entries (interrupt-then-fresh), attachments verbatim, tool_result-only continuation, malformed line skip, unknown top-level types, empty assistant id ignored.

**Tuglaws cross-check:**

- N/A — Rust crate; no React.

**Checkpoint:**

- [x] `cargo nextest run -p tugcast` — green (600 pass, +20 from Step 4.8).
- [x] `bun test` (tugcode) — green (322 pass; tugcode's `runReplay` reads the bootstrapped rows via the same Step 4.6 path).
- [x] `just lint` — clean.

---

#### Step 5: Rip-and-simplify — claude-id-keyed wire, ledger as submission journal only {#step-5}

**Decision:** [DM08].

**Supersedes:** [DM07] (retired). Reverts the wire-shape additions from [Step 4.2](#step-4-2), the tugcode adoption work from [Step 4.5](#step-4-5), the ledger-driven replay path from [Step 4.6](#step-4-6), and the migration scaffolding from [Step 4.8](#step-4-8). Preserves the `turns` table (narrowed) and the supervisor-side intercepts from [Step 4.1](#step-4-1), [Step 4.3](#step-4-3), [Step 4.4](#step-4-4), [Step 4.7](#step-4-7) — those primitives stay; their roles narrow.

**References:** [DM08]; [DM07]'s retirement note; smoke-test failure logged 2026-05-05; user's design-goal quotes preserved in [DM08]; [Never-drop chain audit](#step-5-never-drop) (the load-bearing reference for the per-substep recovery story); [E1 verdict](#e1-jsonl-flush-timing) (JSONL flush timing race, still relevant for the [Step 5.5](#step-5-5) predicate); [E2 verdict](#e2-live-replay-ordering) (live/replay ordering); [E4 drop audit](#e4-drop-audit) (the broader drop-point picture from Phase 0 — the Step 5 chain audit narrows it); the resume-plan's [D04] reducer dedupe (load-bearing, unchanged); the resume-plan's [D08] orphan synthesis (revisited and changed by [Step 5.5](#step-5-5)).

##### Why this Step exists {#step-5-why}

Step 4 shipped as authored. All unit and integration tests passed (602 tugcast + 322 tugcode). Manual smoke testing failed: type "hello", wait for response, `Developer > Reload`, expect transcript restored — actual: empty window. Two architectural commitments around the same problem ([DM03] / [DM07]) had now produced two non-functional integrations whose unit tests didn't catch the failure.

The user's diagnosis on 2026-05-05 named the design itself as the problem:

> "Three independent paths (live insert, ledger replay, cold-boot fallback) each with their own id semantics, plus a 'migration' that has to bridge them, and any platform path-resolution wrinkle takes the whole thing down. WHY is this still so complicated and fragile?"

Step 5 collapses those three paths into one: tugcode forwards what claude says (live), reads JSONL via `translateJsonlSession` (resume), and consults a small submission journal ONLY to recover submissions that crashed before claude acknowledged them (never-drop). One id space (claude's `message.id`); one rendering path; one place where the journal earns its keep.

The user's design-goal quotes from the same conversation (preserved in [DM08]) are the load-bearing constraint:

> "The front end is not doing much work. The reducer's existing msg_id-keyed accumulation handles everything. Claude Code keeps ticking. Tugcast keeps ticking. The card just observes."

> "We must NEVER drop a message on the floor — one way or another."

##### Architecture summary {#step-5-architecture}

```
                                                    +------------------+
                                                    |   sessions.db    |
                                                    |  (sqlite, WAL)   |
                                                    |                  |
                                                    |  sessions   ←→ existing
                                                    |  turns      ←─ NARROWED to journal:
                                                    |               (journal_id, session_id,
                                                    |                user_text, attachments,
                                                    |                created_at)
                                                    +--------+--+------+
                                                       writer^  ^reader
                                                             |  |
   tugdeck                tugcast                   tugcode  |  |
     |  user_message        |  intercept user_message:        |  |
     |───────────────────→  |  INSERT pending journal row ─┐  |  |
     |                      |  forward user_message (no    └──┘  |
     |                      |    augmentation) ─────────→ tugcode receives unchanged
     |                      |                              ActiveTurn.msgId = placeholder
     |                      |                              (canonicalizes to claude's
     |                      |                               message.id on first stream
     |                      |                               event — DM03 mechanism)
     |                      |                              writes to claude.stdin
     |                      |                              ...streams...
     |                      |  ←──── turn_complete         emits turn_complete with
     |                      |        (claude's id only;    msg_id = claude's message.id;
     |                      |         no claude_message_id  no journal id on wire
     |                      |         field on wire)
     |                      |  intercept turn_complete:
     |                      |  DELETE oldest pending ───┐
     |                      |  row for session (FIFO);  │
     |                      |  forward turn_complete    └────┐
     |                      |    unchanged                   │
     |  ←───────────────────|                                │
     |                      |                                │
     |  request_replay      |                                │
     |───────────────────→  |  forward ────────────────────→ tugcode opens sessions.db
     |                      |                                READ-ONLY (Bun's bun:sqlite)
     |                      |                                — ALREADY OPEN from Step 4.5;
     |                      |                                no schema change here.
     |                      |                                runReplay:
     |                      |                                  1. SELECT pending journal
     |                      |                                     rows for this session.
     |                      |                                  2. translateJsonlSession
     |                      |                                     reads JSONL.
     |                      |                                  3. For each pending row
     |                      |                                     whose user_text is NOT
     |                      |                                     in JSONL, emit synthetic
     |                      |                                     user_message_replay
     |                      |                                     (no terminal event).
     |                      |                                  4. Run translator pass:
     |                      |                                     emits frames keyed by
     |                      |                                     claude's message.id from
     |                      |                                     JSONL. Trailing in-flight
     |                      |                                     turn (no end_turn) emits
     |                      |                                     content but no terminal.
     |                      |  ←────── replay events ─── tugcode emits
     |  ←───────────────────|
```

The journal's only durable role is plugging the gap between "user submitted" and "claude wrote user_message line to JSONL." Once claude has acknowledged the submission, the journal row is deleted (FIFO match in the merger) and the submission is fully represented in JSONL going forward.

##### Never-drop guarantee — full chain audit {#step-5-never-drop}

User-quoted requirement (verbatim, 2026-05-05):

> "We must NEVER drop a message on the floor — one way or another."

This subsection enumerates **every** point on the wire path where a user submission could be lost, and names the recovery mechanism for each. Step 5 ships only when each row's recovery is implemented and pinned by a test. This table is the load-bearing reference for confirming that the design delivers the guarantee — when reviewing future work or debugging a "I submitted that and it's gone" incident, every drop point must trace back to one of these rows.

| # | Drop point | Window | What's preserved | Recovery mechanism | Pinned by |
|---|---|---|---|---|---|
| 1 | User clicks Submit; tugdeck's submit handler hasn't yet called `WebSocket.send` | Sub-millisecond (single event-loop tick) | Nothing yet (tugdeck has the text in a local React state slot until `send` fires) | **Out of scope for Step 5.** A follow-on can persist drafts to `localStorage` before `send`. The window is in-process and tiny. | (none — flagged as known gap, not a Step 5 deliverable) |
| 2 | tugdeck → tugcast in flight; WebSocket frame transmitted but tugcast hasn't received | TCP transit + WebSocket framing — milliseconds at worst on localhost | Nothing yet (the frame is in TCP's hands; if the connection drops, the frame is lost) | **Acceptable.** TCP+localhost is reliable; a renderer crash mid-send is the only realistic failure, and that drops at point 1 anyway. | (none — accepted) |
| 3 | tugcast received `user_message`; `dispatch_one` hasn't yet INSERTed the journal row | Sub-millisecond inside the supervisor task | Nothing on disk; the frame is on the channel between bridge and supervisor | **Acceptable.** A tugcast crash here also crashes tugcode (tugcode is a child); on respawn the message is gone. The window is bounded by the time between the channel send and the SQLite INSERT (a single function-call sequence). | (covered by [Step 4.3](#step-4-3) — already shipped) |
| 4 | tugcast INSERTed the row; hasn't yet forwarded to tugcode | Sub-millisecond (the forward immediately follows the insert) | **Row in `sessions.db` (durable; WAL mode)** | On tugcast restart + tugcode respawn: `runReplay` reads the pending row; user_text not in JSONL (claude never received) → emit synthetic `user_message_replay`; user sees their submission rendered as awaiting. Subsequent recovery (re-send to claude vs. surface as "lost — retry?") is out of Step 5 scope. | [Step 5.6](#step-5-6) (synthetic emit); manual smoke "submit-then-Cmd-Q-before-response" |
| 5 | Frame reached tugcode; tugcode hasn't written to claude's stdin | Sub-millisecond inside tugcode's IPC handler | Row in ledger (from point 4 forward) | Same as point 4. The pending row remains; on resume the synthetic emit fires. | [Step 5.6](#step-5-6) |
| 6 | claude received the user_message; hasn't yet written it to JSONL | Bounded by claude's internal write-buffering — typically tens of ms; Phase 0 [E1 verdict](#e1-jsonl-flush-timing) measured 2–6 ms for the related `result`/JSONL race | Row in ledger | On resume: pending-row replay sees no JSONL match for the row's `user_text` → synthetic emit. When claude resumes via `--resume`, it picks up where it left off; if it had already received but not flushed, the JSONL eventually gains the entry and the merger reconciles the row on the next `turn_complete`. | [Step 5.6](#step-5-6); [Step 5.5](#step-5-5) (in-flight predicate keeps the partial assistant content visible) |
| 7 | JSONL has user_message line + partial assistant content + no `end_turn`; claude is mid-stream when reload happens | Bounded by claude's response time — seconds to a minute | JSONL on disk + row in ledger (the row is still pending until merger sees `turn_complete`) | Translator reads JSONL via `translateJsonlSession`; the in-flight predicate emits the user_message_replay + thinking/assistant content with **no terminal event** (per [Step 5.5](#step-5-5)). Reducer holds `pendingUserMessage` and `scratch[claude_id]`. claude `--resume` continues the stream; live `turn_complete` arrives with the same `claude_message_id`; reducer commits the TurnEntry naturally. The merger's intercept then deletes the journal row. | [Step 5.5](#step-5-5) (predicate test); [Step 5.6](#step-5-6) regression; manual smoke "reload during steady-state streaming" |
| 8 | JSONL has complete turn (user_message + assistant + `end_turn`); merger hasn't yet seen the `turn_complete` frame to delete the row | Bounded by merger task scheduling — sub-millisecond typically | JSONL has the full turn; row is stale-pending in ledger | On resume: pending-row replay sees the row's `user_text` matches a `user_message` line in JSONL → does NOT emit a synthetic. The translator pass emits the full turn from JSONL (committed turn). `reconcile_pending_for_session` sweeps the stale row on session resume. | [Step 5.6](#step-5-6) (matched-row no-emit assertion); [Step 4.7](#step-4-7) reconcile (retained, role narrowed to text-match-against-JSONL) |
| 9 | Whole-app crash (Cmd-Q without warning, kernel kill, power loss) at any of the above points | Variable | `sessions.db` (WAL mode survives abnormal termination); JSONL (whatever claude flushed before crash) | On Tug.app relaunch: tugcast spawns fresh, opens `sessions.db`; tugdeck spawns fresh, restores card bindings (existing logic); per-session `runReplay` runs the same chain — translator pass + pending-row replay. There is no separate cold-boot path; the per-reload chain handles cold boot identically. | All Step 5 substeps; manual smoke "Cmd-Q-before-response then relaunch"; manual smoke "HMR cycle during a live conversation" |
| 10 | Sessions.db itself corrupted or deleted | Disaster | JSONL on disk (claude's archive) | Out of scope for Step 5. The user loses pending submissions that never reached claude; submissions that DID reach claude are recoverable by reading JSONL (translator pass works without ledger). The journal-as-ledger is the recovery mechanism for points 4–6 only. If the journal is gone, points 4–6 lose their recovery story; points 7–9 still work. | (out of scope — sessions.db has standard SQLite durability) |

**Acknowledged residual gaps (named explicitly so they don't masquerade as silent drops):**

- **(a) Multi-pending singleton overwrite.** If the user submits multiple messages while claude is silent (e.g., "hello", then "world", before claude has responded to "hello"), then reloads — Step 5.6 emits a synthetic `user_message_replay` per pending row. The reducer's `pendingUserMessage` is a singleton; the second emit overwrites the first. "hello" is invisible until claude responds to it (at which point it commits a normal TurnEntry from the JSONL pass). **The message is not dropped** — it is durably persisted in the ledger, claude will receive it on resume, and the eventual response will commit a TurnEntry. The visibility gap during the pending window only affects the multi-pending scenario, which is uncommon. Confirmed-acceptable 2026-05-05; if dogfooding shows the visibility gap matters, the fix is a tugdeck reducer change to make `pendingUserMessage` a queue.

- **(b) Stuck-pending-no-claude-response.** If JSONL has a partial in-flight turn (point 7 above) and claude *never* resumes to finish the stream — claude permanently dead, network permanently gone — the in-flight predicate fix means no terminal event ever fires. `pendingUserMessage` stays set; TurnEntry never commits; UI shows "in progress" indefinitely. **The message is not dropped** — the user_message and partial assistant content are visible in the transcript via the JSONL pass. Only the closure indicator is missing. Confirmed-acceptable 2026-05-05; mitigation is a client-side watchdog that synthesizes a terminal event after a timeout. Behavior is additive (does not modify the never-drop chain); deferred to a follow-on.

**How to use this table:**

When debugging a reported "my submission disappeared" incident, walk this table top to bottom. The submission must be on either (a) the network in flight, (b) the ledger in `sessions.db`, (c) the JSONL on disk, or (d) the tugdeck reducer's state. If it's not in any of those, the drop is at point 1 (pre-WebSocket) and the fix is tugdeck draft persistence. If it IS in one of those but isn't rendered, the drop is in the recovery mechanism's emit path — which is implemented by exactly one of the Step 5 substeps named in the rightmost column.

##### Delivery chain — HMR-mid-stream verification (2026-05-06 remediation) {#step-5-delivery-chain}

The original never-drop chain (above) walks the **submission** path: where the user's submitted text could be lost between Submit click and persistent storage. It's a durability table.

The remediation work in [Step 5.11](#step-5-11) uncovered that submission durability is not enough — content can be **durably stored and still invisible** if the **delivery** chain has gaps. Specifically, when HMR fires while claude is mid-stream, the new client must reconstruct the in-flight turn's pre-HMR content from server state, because the CODE_OUTPUT broadcast does NOT backfill new subscribers (`LagPolicy::Replay` only triggers on broadcast lag overflow, not on initial subscribe).

This subsection enumerates **every** stage the delivery chain depends on, the test that pins it, and the substep that implements it. Walk this table when debugging an "I submitted that and the response never appeared after HMR/reload" incident.

| # | Stage | What needs to happen | Test | Substep |
|---|---|---|---|---|
| 1 | User submission persisted to journal | Rust ledger inserts pending row before `forward` decision | `session_ledger.rs` insert/list/delete unit tests | [Step 4.3](#step-4-3) (shipped) |
| 2 | Bridge process survives HMR | tugcode keeps running; `ActiveTurn` stays alive; claude keeps streaming into `turn.partialText` | Architectural — HMR is frontend-only; not directly testable | (architecture) |
| 3 | New client subscribes to CODE_OUTPUT | Router gives client a fresh `broadcast::Receiver` | `router.rs` subscribe/teardown tests | (shipped, pre-Step-5) |
| 4 | **`LagPolicy::Replay` does NOT backfill on initial subscribe** | Buffer fires only on `Err(_lagged)` from the broadcast (overflow), not on subscription. New clients see frames sent **after** they subscribe. | (pinned by `router.rs` lag-recovery tests; the absence of backfill-on-subscribe is the load-bearing assumption) | (architecture — known) |
| 5 | runReplay opens bracket | `replay_started` on wire; `inflight.suppressEmit = true`; merger journal-pop gated by Step 5.10 bracket flag | `replay-hmr-mid-stream.test.ts` "no activeTurn" test + Rust 5.10 `journal_gate_*` tests | [Step 5.10](#step-5-10) |
| 6 | Pending-row synthetic for unmatched journal rows | Step 5.6 `injectPendingRowSynthetics` emits `user_message_replay` keyed on `journal_id` for pending rows whose `user_text` doesn't appear as a `user_message` line in JSONL | `replay-pending-row-injection.test.ts` (8 tests) | [Step 5.6](#step-5-6) |
| 7 | JSONL committed turns replayed (per-message keying) | Translator emits frames keyed on each `assistant` JSONL entry's own `message.id`; multi-message claude turns split into separately-keyed wire streams; `turn_complete` only on `stop_reason === "end_turn"`; `tool_result` emits directly from the `user` entry that carries it | `replay.test.ts` "multi-message cycle" + tool ordering + thinking msg_id tests | [Step 5.11](#step-5-11) |
| 8 | **In-flight turn snapshot delivered** | `runReplay` calls `emitInflightTurnFromActiveTurn(inflight)` after the JSONL pass and before `replay_complete`. Snapshot keys on `turn.currentMessageId` (claude's most recent `message.id`); writes consolidated `assistant_text { is_partial: false }` from `turn.partialText`; synthesizes terminal if `gotResult`/`interrupted` latched while suppressed. | `replay-hmr-mid-stream.test.ts` "snapshot lands inside bracket" + multi-frame ordering + terminal-synthesis tests (7 tests) | [Step 5.11](#step-5-11) |
| 9 | Bracket closes | `replay_complete` on wire | tugcode tests | (shipped) |
| 10 | `suppressEmit` clears in `finally` | Future live deltas resume from `dispatchEventToTurn` | session.ts `finally` block | (shipped) |
| 11 | Reducer keys content by claude's `message.id` (sliding pointer) | `ActiveTurn.currentMessageId` slides on every `message_start` and top-level `assistant` snapshot. No canonicalize/reject; multi-message claude turns produce separate UI panels keyed by their respective ids. | `session.test.ts` "slides currentMessageId" describe block (7 cases) | [Step 5.11](#step-5-11) |
| 12 | **Reducer preserves in-flight cycle on `replay_complete`** | If `pendingUserMessage` is set when bracket closes (snapshot landed without matching `turn_complete`), reducer preserves `pendingUserMessage` + `scratch` + `activeMsgId` and transitions to `streaming` (not `idle`). Without this, post-bracket deltas hit `handleTextDelta`'s phase guard and are silently dropped. | `reducer.replay-inflight-survival.test.ts` (4 tests covering preservation + post-bracket append + live-tail commit + no-regression for clean replays) | [Step 5.11](#step-5-11) |
| 13 | Post-bracket `is_partial: true` deltas append onto preserved scratch | `handleTextDelta` accepts in `streaming` phase; appends delta text onto `scratch[msgId].assistant` | reducer test "post-bracket live delta after preserved snapshot: appends, doesn't drop" | [Step 5.11](#step-5-11) |
| 14 | Live `turn_complete` commits `TurnEntry` | Reducer emits `append-transcript` effect with body = snapshot text + post-bracket deltas | reducer test "live turn_complete after preserved snapshot: emits append-transcript effect with full body" | [Step 5.11](#step-5-11) |
| 15 | Merger FIFO journal pop on terminal | Step 5.10 bracket gate skips replay-emitted `turn_complete`s; live terminal pops one row per cycle | Rust `journal_gate_*` tests in `agent_supervisor.rs` | [Step 5.10](#step-5-10) |

**How to use this table:**

When debugging a reported "I submitted that, claude responded, but I see nothing after HMR/reload" incident, walk this table top to bottom. The chain is end-to-end: every stage must work for the user-visible outcome to land. Each row names the substep that implements it and the test that pins it. If one stage breaks, the failure mode tells you which: stage 5 break = no bracket; stage 8 break = empty card after HMR-mid-stream (the 2026-05-06 symptom); stage 12 break = bracket lands but post-bracket deltas drop in `idle` phase (the second 2026-05-06 symptom).

**Why this remediation was needed despite the original chain audit being implemented:** The original never-drop audit verified durability — that the submission won't be **lost**. It treated delivery as implicit. The HMR-mid-stream regression revealed three independent delivery-chain failures that durability alone didn't catch: (1) tugcode's `canonicalizeMsgId` ladder rejecting claude's second `message.id` in multi-message turns, (2) `runReplay` not invoking `emitInflightTurnFromActiveTurn` (dead code after Step 5.4's translator-driven revert), (3) `handleReplayComplete` unconditionally wiping the in-flight cycle. Each was masked by tests that exercised one part of the chain in isolation. The new tests pin the integration shape end-to-end so any future regression surfaces as a test failure rather than a production-only observation.

##### What from Step 4 survives, and what gets reverted {#step-5-what-survives}

**Reverted:**

- [Step 4.2] all wire shape additions — `tug_turn_id` field on `UserMessage` removed (Rust + TS); `claude_message_id` field on `TurnComplete` removed (Rust + TS).
- [Step 4.5] tugcode adoption of `tug_turn_id` from envelope — `handleUserMessage` no longer reads `msg.tug_turn_id`; `ActiveTurn.msgId` no longer sources from envelope. The pre-Step-4 mechanism returns: `msgId` is a placeholder UUID at install time, canonicalized to claude's `message.id` on the first stream event ([DM03]'s mechanism is restored — its known race window is now structurally tolerable because the journal-driven pending-row replay covers the failure mode independently).
- [Step 4.5] `ActiveTurn.claudeMessageId` field — no longer needed; `turn_complete` frames don't carry `claude_message_id` anymore. The `setClaudeMessageId` plumbing in `dispatchEventToTurn` and the corresponding capture sites in `mapStreamEvent` / `routeTopLevelEvent` come out.
- [Step 4.6] `runLedgerDrivenReplay` in `tugcode/src/session.ts` — deleted. `runReplay` reverts to calling `translateJsonlSession` for committed-turn replay.
- [Step 4.6] `extractTurnContent` in `tugcode/src/replay.ts` — deleted. Content lookup by `claude_message_id` was the load-bearing role of this function; it has no purpose with translator-driven replay.
- [Step 4.6] `rekeyTurnContent` and any other Step-4-era re-keying utilities — deleted.
- [Step 4.8] `bootstrap_turns_from_jsonl` in `session_ledger.rs` — deleted. The journal only ever holds *currently pending* submissions; no historical bootstrap is needed.
- [Step 4.8] `canonical_project_dir_for_jsonl` (the macOS APFS firmlink prefix-stripping helper) — deleted. JSONL path resolution moves entirely to tugcode; tugcast no longer reads JSONL.
- [Step 4.8] `tugrust/crates/tugcast/src/jsonl_reader.rs` — the minimal Rust JSONL parser added for the bootstrap migration. Whole file deleted.
- [Step 4.1] schema columns: `claude_message_id`, `partial_text`, `completed_at` from the `turns` table. The `state` column collapses to "row exists = pending; row deleted = seen" (i.e., the column itself is removed). Migrations table bumps to v3.
- [Step 4.4] `mark_turn_complete` and `mark_turn_interrupted` ledger API methods — deleted. Replaced by `delete_oldest_pending_for_session` (FIFO match on the merger's `turn_complete` intercept).
- [Step 4.7] `record_partial_text` and the deferred `partial_text` snapshot pathway — deleted (was already an unused TODO; Step 5 closes the door).

**Survives (with narrowed role):**

- [Step 4.1] `turns` table — schema narrowed (5 columns: `journal_id`, `session_id`, `user_text`, `user_attachments`, `created_at`). `turns_cascade_delete_on_session` trigger preserved unchanged. `migrations` table preserved (used to track the Step 5 narrowing as v3).
- [Step 4.1] `turns_session_created` index (was `turns_session_ordinal`; renamed to reflect the column rename — `created_at` replaces `ordinal` as the ordering key for FIFO match).
- [Step 4.3] `dispatch_one`'s inbound `user_message` intercept — keeps the row insert. The augmentation (mutating the frame to add `tug_turn_id`) comes off; the frame forwards unchanged. The internal journal id is recorded on the row only.
- [Step 4.4] `apply_outbound_turn_intercept` in the merger — keeps the intercept on `turn_complete`. The role narrows: instead of `UPDATE turns SET claude_message_id = ?, state = 'complete' WHERE tug_turn_id = ?`, the new behavior is `DELETE FROM turns WHERE journal_id = (SELECT journal_id FROM turns WHERE session_id = ? ORDER BY created_at LIMIT 1)` — FIFO match. The merger no longer extracts `claude_message_id` from the frame (it's not on the wire).
- [Step 4.5] `bun:sqlite` read-only handle in `SessionManager` — kept. Opened at construction; held for lifetime; reused across `runReplay` invocations. Used by the new pending-row injection logic in `runReplay`.
- [Step 4.7] `reconcile_pending_for_session` — survives, narrowed. The role becomes "on session resume, sweep pending rows older than the configured TTL (e.g., 5 minutes) — they correspond to submissions whose claude side never landed. Surfaces them via a new wire signal so the user sees the submission rendered as 'lost — retry?'" The fine-grained "match by `claude_message_id`" logic from Step 4 is gone.
- [Step 3] `ActiveTurn.suppressEmit` and the seven gated `writeLine` sites — still load-bearing for keeping live drain emits off the wire during `runReplay`'s bracket window.
- [Step 3] `emitInflightTurnFromActiveTurn` — kept. Inputs revert: `turn.msgId` is canonicalized from claude's `message.id` (Step 4.5's tug_turn_id source comes off).
- [Step 3] [DM06] crash-during-suppression mitigation — the `gotResult` / `interrupted` terminal-event branches keep the bracket delivering a complete TurnEntry when the drain dies mid-replay.

**Newly added:**

- `runReplay`'s pending-row injection: a new pre-translator pass that queries the journal and emits synthetic `user_message_replay` frames for pending rows whose `user_text` does not appear as a `user_message` line in the JSONL. The injected frames carry the journal id as `msg_id` (a temporary key) and no terminal event. The reducer's `pendingUserMessage` slot rebinds to claude's id when the first response frame arrives post-replay, per [DM08]'s implications.
- `translateJsonlSession`'s in-flight predicate: when the trailing turn has no `end_turn`, the translator emits the accumulated content (`thinking_text`, `assistant_text`, `tool_use`) but **no terminal event**. The reducer's accumulation stays open; live frames continuing post-replay produce the eventual `turn_complete` naturally. Reducer is unchanged. Replaces the previous orphan-synthesis path that emitted a synthetic `turn_complete{interrupted}` (which was the original 2026-05-05 mid-turn bug — the "interrupted" was wrong when the turn was actually still streaming).

##### Substep overview {#step-5-substeps-overview}

Step 5 ships in 8 substeps. Each is a single coherent commit, each leaves the build green (warnings-as-errors), each has a failure-first proof for any new behavior the substep introduces. Substep ordering is chosen so that intermediate states keep the build green even if a smoke test would fail at that intermediate point — the user-visible smoke test passes at substep 5.6 when the pending-row replay lands; substep 5.7 deletes the now-orphaned migration scaffolding; substep 5.8 closes out [DM07] and confirms the smoke.

| Substep | Topic | Touches | Commit message |
|---|---|---|---|
| 5.1 | Wire revert | `tugcast` (Rust IPC types), `tugcode/src/types.ts` | `tide(turns): revert wire — drop tug_turn_id from UserMessage, claude_message_id from TurnComplete` |
| 5.2 | Schema narrow | `tugrust/crates/tugcast/src/session_ledger.rs` | `tugcast(journal): narrow turns to submission journal — drop claude_message_id, partial_text, completed_at, state` |
| 5.3 | Intercept narrow | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | `tugcast(journal): merger turn_complete intercept narrows to FIFO mark-seen` |
| 5.4 | Restore translator-driven replay | `tugcode/src/session.ts`, `tugcode/src/replay.ts` | `tugcode(journal): restore translateJsonlSession path; delete runLedgerDrivenReplay + extractTurnContent` |
| 5.5 | Translator predicate fix | `tugcode/src/replay.ts` | `tugcode(replay): in-flight trailing turn emits content without terminal event` |
| 5.6 | Pending-row replay | `tugcode/src/session.ts` | `tugcode(journal): inject synthetic user_message_replay for pending rows not in JSONL` |
| 5.7 | Delete migration scaffolding | `tugrust/crates/tugcast/src/session_ledger.rs`, deletes `jsonl_reader.rs` | `tugcast(journal): delete bootstrap_turns_from_jsonl, jsonl_reader, canonical_project_dir_for_jsonl` |
| 5.8 | Close-out: tests + docs | tests + this plan | `tide(journal): submission-journal smoke + retire DM07` |

Plus the close-out at [Step 6](#step-6) which retests Smoke D end-to-end against the new design.

---

##### Step 5.1: Wire revert — drop `tug_turn_id` and `claude_message_id` {#step-5-1}

**Commit:** `tide(turns): revert wire — drop tug_turn_id from UserMessage, claude_message_id from TurnComplete`

**Depends on:** none (foundation; pure type+plumbing revert).

**References:**

- [DM08] — the decision; in particular the "Wire shape reverts" and "Tugcode's adoption changes" bullets under Implications.
- [DM03] — the canonicalization mechanism this substep restores. [DM03]'s race window is reopened by this revert; that's structurally tolerable per [DM08]'s rationale because [Step 5.6](#step-5-6) plugs the failure mode independently via the journal.
- [DM07] (retired) — the design that introduced the wire fields being removed.
- [Step 1](#step-1) — original home of the canonicalization plumbing being restored (`canonicalizeMsgId`, `messageId` on `EventMappingResult` / `TopLevelRoutingResult`, the `message_start` branch in `mapStreamEvent`, the assistant-snapshot extraction in `routeTopLevelEvent`).
- [Step 4.2](#step-4-2) — the wire-shape commit being reverted.
- [Step 4.5](#step-4-5) — the tugcode adoption commit being reverted.
- [E2 verdict](#e2-live-replay-ordering) — the original live/replay msg_id-divergence observation. The divergence returns with this revert; the never-drop chain (below) absorbs it.
- [Never-drop chain audit](#step-5-never-drop) rows 1–3 — wire transit drop points (in-process tugdeck, WebSocket flight, tugcast ingress) characterized as acceptable; this substep doesn't change row 1–3 behavior (the journal-backed rows are introduced in [Step 5.6](#step-5-6)).
- Resume plan's [D04] — reducer's `msg_id`-keyed dedupe is the contract this substep is restoring on the wire.

**Artifacts:**

- `tugrust/crates/tugcast/src/ipc/types.rs` (or wherever the IPC envelope types live in Step 4.2's home) — `tug_turn_id` field removed from `UserMessage`. `claude_message_id` field removed from `TurnComplete`. Both fields existed only between Step 4.2 and Step 5.1.
- `tugcode/src/types.ts` — same removals on the TS side. `UserMessage.tug_turn_id` and `TurnComplete.claude_message_id` come off. Conditional-spread sites (`{ ...(turn.claudeMessageId ? { claude_message_id: turn.claudeMessageId } : {}) }` from Step 4.5) come off.
- `tugcode/src/session.ts` — `handleUserMessage` no longer reads `msg.tug_turn_id`. `ActiveTurn.msgId` reverts to the pre-Step-4 mechanism: `crypto.randomUUID()` placeholder at install, canonicalized to claude's `message.id` on the first stream event (the [DM03] mechanism returns).
- `tugcode/src/session.ts` — `ActiveTurn.claudeMessageId` field removed. `setClaudeMessageId` method removed. `dispatchEventToTurn`'s `setClaudeMessageId` call sites removed.
- `tugcode/src/session.ts` — `mapStreamEvent` and `routeTopLevelEvent`: the [DM03] canonicalization plumbing returns. `messageId` field on `EventMappingResult` and `TopLevelRoutingResult` is restored. `mapStreamEvent`'s `message_start` branch surfaces `messageId`. `routeTopLevelEvent`'s `case "assistant"` extracts `message.id` for canonical-id flow.
- `tugcode/src/session.ts` — `ActiveTurn.msgId` is `mutable until first canonicalization`, frozen after. The Step 4.5 `readonly` declaration reverts.
- `tugcode/src/session.ts` — `dispatchEventToTurn` re-introduces canonicalize-after-route and canonicalize-after-stream blocks (Step 1's plumbing) — these blocks were deleted in Step 4.5's revert; they come back here.

**Tasks:**

- [x] Remove `tug_turn_id` field from `UserMessage` IPC type (Rust + TS).
- [x] Remove `claude_message_id` field from `TurnComplete` IPC type (Rust + TS).
- [x] Remove `claudeMessageId` capture from `ActiveTurn` (TS).
- [x] Restore `messageId` field on `EventMappingResult` / `TopLevelRoutingResult` (TS).
- [x] Restore canonicalize-after-route / canonicalize-after-stream blocks in `dispatchEventToTurn` (TS).
- [x] Update `handleUserMessage` to mint a placeholder UUID locally (no longer reads from envelope).
- [x] Update Step 4.2 / 4.5 tests in `session.test.ts`: tests that asserted on `tug_turn_id` from envelope, `claude_message_id` on `turn_complete`, or `claudeMessageId` capture come out (or revert to their pre-Step-4 form).

**Tests:**

- [x] **Wire shape**: drive a synthetic `handleUserMessage`; assert the outbound `user_message` frame on tugcode's stdout has no `tug_turn_id` field. Assert the outbound `turn_complete` frame has no `claude_message_id` field.
- [x] **Canonicalization restored**: drive `handleUserMessage` (local UUID), then `message_start` with `message.id = "claude_X"`; assert `activeTurn.msgId === "claude_X"` after the canonicalization step (the pre-Step-4 behavior).
- [x] **Regression**: full `bun test` — all surviving tests pass; tests that assert on the now-removed fields are deleted or updated in this same commit.

**Tuglaws cross-check:**

- N/A — tugcode bridge subprocess; no React.

**Checkpoint:**

- [x] `bun test` (tugcode) — green (324 pass; +2 wire-shape pin tests added).
- [x] `cargo nextest run` — green (1294 pass; -8 from deletion of parse_message_type / parse_tug_turn_id / parse_claude_message_id tests).
- [x] `just lint` — clean.

---

##### Step 5.2: Schema narrow — `turns` becomes a submission journal {#step-5-2}

**Commit:** `tugcast(journal): narrow turns schema to submission journal; nuke + recreate, no migration`

**Depends on:** [Step 5.1](#step-5-1) (wire is already free of the soon-to-be-deleted columns' downstream consumers).

**References:**

- [DM08] — the decision; in particular the "Ledger schema narrows" bullet under Implications, which spells out the exact columns coming off and the API methods being deleted.
- [Step 4.1](#step-4-1) — origin of the schema being narrowed. The `turns_cascade_delete_on_session` trigger from 4.1 is preserved; the columns from 4.1 that bridged ids and back-referenced content come off.
- [Architecture summary](#step-5-architecture) — the new 5-column journal shape (`journal_id`, `session_id`, `user_text`, `user_attachments`, `created_at`).
- [What survives](#step-5-what-survives) — the "Reverted" / "Survives" enumeration that this substep enacts on the schema side.
- [Never-drop chain audit](#step-5-never-drop) row 4 — the durability promise this schema underwrites: "Row in `sessions.db` (durable; WAL mode)." A pending row inserted at [Step 4.3](#step-4-3)'s `dispatch_one` intercept survives every drop scenario from row 4 through row 9.
- [Resume / fork / continue semantics](#step-4-resume-fork-continue) — Step 4's resume/fork/continue analysis still applies; the narrowed schema does not change those semantics (forks still start with empty journal; resume reuses the existing rows; continue resolves to the most-recent session id).

**No-migration policy (decided 2026-05-05):**

There are no users to migrate, no production data to preserve. Tugtool is a single-developer dogfooding tool at this stage; the only `sessions.db` in existence is the developer's. The right move is therefore: **drop the existing `turns` table on first open, create the new schema fresh, delete any dead `migrations` infrastructure that was speculative.** No conditional ALTER paths, no version-gated copy logic, no idempotency dance for an upgrade scenario that doesn't exist. The narrowed schema is authored as the *only* shape `ensure_schema` ever creates.

The developer's local `sessions.db` will lose any in-flight pending rows from before the upgrade. That is fine — pending rows older than the upgrade boundary correspond to submissions claude already acknowledged (the merger's intercept narrowing in [Step 5.3](#step-5-3) replaces the old "mark complete" path with FIFO delete, and the existing rows have no claude response coming back to delete them anyway). The developer flushes their `sessions.db` once before the new code runs and starts fresh from there.

**Artifacts:**

- `tugrust/crates/tugcast/src/session_ledger.rs` — `ensure_schema` is rewritten to create the narrowed `turns` table directly. No `migrations` table. Step 4.1's v2 schema (with `claude_message_id`, `partial_text`, `state`, `completed_at`, `ordinal`) goes away entirely.

  ```sql
  -- The single shape ensure_schema creates. No migration; no version table.
  -- A user upgrading from Step 4.1's schema should DELETE FROM turns + DROP
  -- TABLE turns + DROP TRIGGER turns_cascade_delete_on_session before
  -- running the new code, OR simply delete sessions.db (it gets recreated
  -- on first open). Tugtool has no production users; this is the
  -- developer's local file only.
  CREATE TABLE IF NOT EXISTS turns (
      journal_id        TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      user_text         TEXT NOT NULL,
      user_attachments  BLOB NOT NULL,            -- JSON array (serde_json)
      created_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS turns_session_created
      ON turns(session_id, created_at);

  CREATE TRIGGER IF NOT EXISTS turns_cascade_delete_on_session
  AFTER DELETE ON sessions
  FOR EACH ROW
  BEGIN
      DELETE FROM turns WHERE session_id = OLD.session_id;
  END;
  ```

- `tugrust/crates/tugcast/src/session_ledger.rs` — Rust API narrows:
  - `insert_pending_turn(session_id, journal_id, user_text, attachments, now)` — keeps shape; column rename internally (`tug_turn_id` → `journal_id`). Caller mints the id externally so the merger and dispatcher share the source.
  - `delete_oldest_pending_for_session(session_id) -> Option<JournalRow>` — NEW. FIFO match on `created_at ASC LIMIT 1`. Returns the deleted row's content for logging.
  - `list_pending_turns_for_session(session_id) -> Vec<JournalRow>` — NEW. Returns all pending rows for a session, ordered by `created_at`. Used by tugcode's `runReplay` (via the read-only sqlite handle) for the pending-row injection in [Step 5.6](#step-5-6). Replaces the content-bearing variant from Step 4.1.
  - `mark_turn_complete` — DELETED.
  - `mark_turn_interrupted` — DELETED.
  - `record_partial_text` — DELETED.
  - `list_turns_for_session` (content-bearing variant) — DELETED. Replaced by `list_pending_turns_for_session`.
  - `get_turn_by_claude_message_id` (if it exists) — DELETED.
  - `bootstrap_turns_from_jsonl` — DELETED entirely. (Step 5.7's job folds into 5.2 per the no-migration policy.)
  - Migrations module / table / version-tracking helpers — DELETED. There is no `migrations` table to track; the schema is whatever `ensure_schema` creates today.
- `tugrust/crates/tugcast/src/session_ledger.rs` — `canonical_project_dir_for_jsonl` (the macOS firmlink stripper) DELETED. JSONL path resolution lived only inside bootstrap, which is gone. (Step 5.7's job folds into 5.2.)
- `tugrust/crates/tugcast/src/jsonl_reader.rs` — entire file DELETED. Used only by bootstrap. (Step 5.7's job folds into 5.2.)
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — the bootstrap call in `do_spawn_session`'s eager-spawn block DELETED. The `reconcile_pending_for_session` call survives (its narrowed role per 5.3+5.6 lives on per [DM08]'s implications).
- `tugrust/crates/tugcast/src/session_ledger.rs` — `JournalRow` struct (replaces `TurnRow`):
  ```rust
  pub struct JournalRow {
      pub journal_id: String,
      pub session_id: String,
      pub user_text: String,
      pub user_attachments: Vec<UserAttachment>,
      pub created_at: i64,
  }
  ```
- `tugrust/crates/tugcast/src/session_ledger.rs` — supervisor + tugcode test surfaces using the old `TurnRow` / `mark_turn_complete` / `mark_turn_interrupted` / Step 4.1 column names update to the narrow shape. Calls into the deleted methods that the supervisor still makes (the merger intercept's `mark_turn_complete` / `mark_turn_interrupted` calls from Step 4.4) are temporarily stubbed to no-op until Step 5.3 narrows the merger.

**Tasks:**

- [x] Replace v1+v2 schema in `ensure_schema` with the single narrowed schema; drop the `migrations` table creation.
- [x] Delete the `migrations` table read/write helpers from the Rust crate (e.g., `record_migration`, version-bump logic, the `MIGRATION_V2` constant).
- [x] Replace `TurnRow` with `JournalRow`; rename column `tug_turn_id` → `journal_id` in struct, queries, and tests.
- [x] Add `delete_oldest_pending_for_session` API + tests.
- [x] Add `list_pending_turns_for_session` API + tests.
- [x] Delete `mark_turn_complete`, `mark_turn_interrupted`, `record_partial_text`, `list_turns_for_session` (content-bearing), `get_turn_by_claude_message_id` from the API and their tests.
- [x] Stub the merger's still-extant calls to `mark_turn_complete` / `mark_turn_interrupted` (called from `apply_outbound_turn_intercept`) to inert no-ops returning `Ok(())` so the build stays green; Step 5.3 replaces the call sites with `delete_oldest_pending_for_session`. The intent: keep this substep's blast radius bounded to the schema and API; defer behavior change to 5.3.
- [x] Update tests in `session_ledger.rs` to the narrowed shape — schema-shape test, `insert_pending_turn` round-trip, `list_pending_turns_for_session` ordering, `delete_oldest_pending_for_session` FIFO, cascade trigger preserved.

**Tests:**

- [x] **Fresh-database schema shape**: open a fresh ledger; assert `turns` has exactly 5 columns (`journal_id`, `session_id`, `user_text`, `user_attachments`, `created_at`) and the cascade trigger fires on parent session delete.
- [x] **`insert_pending_turn` round-trip**: insert; assert `list_pending_turns_for_session` returns the row.
- [x] **`list_pending_turns_for_session` orders by `created_at` ASC**: insert 3 rows with monotonic `created_at`; assert order.
- [x] **`delete_oldest_pending_for_session` FIFO**: insert 3 rows; call delete 3 times; assert FIFO order; fourth call returns `None`.
- [x] **`turns_cascade_delete_on_session` trigger preserved**: insert journal row; delete the parent session row; assert the journal row is gone.
- [x] **No migrations table**: `SELECT name FROM sqlite_master WHERE type='table'` does NOT include `migrations`.

**Tuglaws cross-check:**

- N/A — Rust crate; no React.

**Checkpoint:**

- [x] `cargo nextest run -p tugcast` — green.
- [x] `just lint` — clean.
- [ ] `just lint` — clean.

---

##### Step 5.3: Merger intercept narrows to FIFO mark-seen {#step-5-3}

**Commit:** `tugcast(journal): merger turn_complete intercept narrows to FIFO mark-seen`

**Depends on:** [Step 5.2](#step-5-2).

**References:**

- [DM08] — the decision; in particular "the journal id (formerly `tug_turn_id`) is internal to tugcast and is not surfaced on the wire — neither inbound `user_message` nor outbound `turn_complete` carries it."
- [Step 4.3](#step-4-3) — origin of `dispatch_one`'s `user_message` intercept. The intercept stays; the augmentation that mutated the frame to add `tug_turn_id` is removed (the wire field came off in [Step 5.1](#step-5-1)). The journal id is recorded internally only.
- [Step 4.4](#step-4-4) — origin of the merger's `apply_outbound_turn_intercept`. The intercept stays; the role narrows from "extract `claude_message_id`, `UPDATE turns SET claude_message_id = ?, state = 'complete'`" to "delete the oldest pending row (FIFO match by `created_at`)."
- [Never-drop chain audit](#step-5-never-drop) row 8 — the merger's `turn_complete`-driven row deletion is the recovery mechanism for the "JSONL has complete turn but row not yet deleted" race. This substep implements the deletion; [Step 4.7](#step-4-7)'s `reconcile_pending_for_session` (retained, role narrowed) handles any missed deletions on session resume.
- [Architecture summary](#step-5-architecture) — the diagram showing the merger intercept boxed in the tugcast lane.
- [What survives](#step-5-what-survives) — the "Survives (with narrowed role)" bullets covering [Step 4.3](#step-4-3) and [Step 4.4](#step-4-4).

**Artifacts:**

- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — `apply_outbound_turn_intercept` narrows. Old behavior: extract `claude_message_id` from the frame, `UPDATE turns SET claude_message_id = ?, state = 'complete' WHERE tug_turn_id = ?`. New behavior: `delete_oldest_pending_for_session(session_id)`. The frame is forwarded unchanged. The merger no longer reads any field from the `turn_complete` frame except `session_id` (which is on the routing envelope, not the payload — already routed by this point).
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — `dispatch_one`'s `user_message` intercept narrows. Old behavior: mint `tug_turn_id`, `INSERT pending`, augment frame with `tug_turn_id`, forward. New behavior: mint internal `journal_id`, `INSERT pending`, forward frame unchanged. The mint and insert stay; the augmentation comes off (the wire field was removed in [Step 5.1](#step-5-1)).

**Tasks:**

- [x] Update `apply_outbound_turn_intercept` to call `delete_oldest_pending_for_session` instead of `mark_turn_complete`. Takes `&TugSessionId` parameter (the merger task already has it from the StreamMap; threaded through the call site).
- [x] Remove `claude_message_id` / `partial_result` / `msg_id` extraction from the frame in the merger; the new intercept reads only the top-level `type` discriminator.
- [x] Update `dispatch_one`'s `user_message` intercept to NOT augment the frame; mint internal `journal_id`, `INSERT pending`, forward unchanged. Delete the `augment_user_message_with_tug_turn_id` helper.
- [x] Drop `mark_turn_complete` and `mark_turn_interrupted` from the `SessionsRecorder` trait, the production impl, and `NoopSessionsRecorder`. Add `delete_oldest_pending_for_session` to all three.
- [x] Delete the now-orphan stubs in `session_ledger.rs` (`mark_turn_complete`, `mark_turn_interrupted`).
- [x] Narrow `payload_inspector::InspectedPayload` to drop the now-unread fields (`msg_id`, `tug_turn_id`, `claude_message_id`, `partial_result`); update its tests.
- [x] Add new Step 5.3 tests in `agent_supervisor.rs`'s test module (the Step 4 sub-modules were deleted in 5.2; this adds back focused coverage of the narrowed surface).

**Tests:**

- [x] **FIFO match across multiple submissions**: simulate two `user_message`s in flight, then two `turn_complete`s; assert the journal rows are deleted in order; final journal row count for the session is 0.
- [x] **`turn_cancelled` pops the journal too** (same path as `turn_complete`).
- [x] **Unrelated frames don't pop the journal** (`assistant_text`, `tool_use`, etc.).
- [x] **Spurious `turn_complete` (no pending rows)**: assert `delete_oldest_pending_for_session` returns `None`; intercept handles gracefully; warn log fires (`turn_complete_no_pending_journal_row`).
- [x] **Per-session isolation**: a `turn_complete` on session B does not pop session A's pending rows.
- [x] **Cascade trigger purges journal when session forgotten** (the "pending row outlives session" case).
- [x] **`dispatch_one` forwards the frame unchanged** — pop the queued frame and assert payload bytes equal the input bytes (no `tug_turn_id` augmentation).

**Tuglaws cross-check:**

- N/A — Rust crate; no React.

**Checkpoint:**

- [x] `cargo nextest run -p tugcast` — green (547 pass; +5 new from 5.3, +2 from `dispatch_one` round-trip and per-session isolation).
- [x] `cargo nextest run` (workspace) — green (1248 pass).
- [x] `just lint` — clean.

---

##### Step 5.4: Restore translator-driven `runReplay`; delete `runLedgerDrivenReplay` and `extractTurnContent` {#step-5-4}

**Commit:** `tugcode(journal): restore translateJsonlSession path; delete runLedgerDrivenReplay + extractTurnContent`

**Depends on:** [Step 5.1](#step-5-1) (wire is free of the Step 4 augmentations).

**References:**

- [DM08] — the decision; in particular "Tugcode's `runReplay` rewires: `runLedgerDrivenReplay` is deleted; `extractTurnContent` is deleted."
- [Step 4.6](#step-4-6) — the ledger-driven `runReplay` and content-only translator path being deleted. The ledger-driven path was the source of the Step 4 smoke-test failure; this substep removes it entirely.
- [`runReplay` flow specification](#run-replay-flow) — the pre-Step-4 design being restored. This substep returns `runReplay` to that shape, with the addition of the [Step 5.6](#step-5-6) pending-row injection layered on top in the next substep.
- [Translator option and "did-skip" reporting](#translator-option) — the pre-Step-4 translator surface. Note that [DM05]'s `liveInflightMsgId` option was already removed in Step 4.6; this substep does not re-introduce it (the in-flight handling is rewritten in [Step 5.5](#step-5-5)'s predicate change instead).
- [Never-drop chain audit](#step-5-never-drop) rows 7–8 — the translator's role: it emits committed turns (row 8) and in-flight content from JSONL (row 7). The predicate fix in [Step 5.5](#step-5-5) is what makes row 7's behavior correct.
- [What survives](#step-5-what-survives) — "Reverted" enumeration: `runLedgerDrivenReplay`, `extractTurnContent`, `rekeyTurnContent` all named. The bun:sqlite handle from [Step 4.5](#step-4-5) survives (held but unused in this substep; used by [Step 5.6](#step-5-6)).
- Resume plan's [D04] — reducer's msg_id-keyed dedupe is the contract that the translator's claude-id-keyed output satisfies.

**Artifacts:**

- `tugcode/src/session.ts` — `runReplay` reverts to its pre-Step-4 shape: open the JSONL via the translator's resolver; emit `replay_started`; call `translateJsonlSession`; emit `replay_complete`. The Step 4.6 ledger-driven branch (the one that read `turns` rows and called `extractTurnContent`) is deleted entirely. The bun:sqlite handle stays open at construction (Step 4.5's plumbing), but is unused in `runReplay` for this substep — it'll come back into use in [Step 5.6](#step-5-6) for pending-row injection.
- `tugcode/src/session.ts` — `runLedgerDrivenReplay` function and any helpers (e.g., `loadTurnsForSession`, `lookupContentByClaudeMessageId`) — DELETED.
- `tugcode/src/replay.ts` — `extractTurnContent` generator — DELETED. Imports for it across the tree (session.ts, tests) come off.
- `tugcode/src/replay.ts` — `rekeyTurnContent` (or any other Step-4 re-keying helpers) — DELETED.
- `tugcode/src/replay.ts` — `translateJsonlSession` shape unchanged from its pre-Step-4 form: it accepts JSONL input, emits frames keyed by claude's `message.id`. This substep does NOT touch the in-flight predicate yet — that's [Step 5.5](#step-5-5).

**Tasks:**

- [x] Delete `runLedgerDrivenReplay` from `session.ts`.
- [x] Delete `readLedgerTurnsForSession` and `decodeUserAttachments` (helpers used only by `runLedgerDrivenReplay`).
- [x] Delete `LedgerTurnRow` type from `session.ts` (no remaining consumers).
- [x] Restore `runReplay` to call `translateJsonlSession` with no special trailing-turn handling. Single path; no ledger branch; no source labelling. Buffered `replay_complete` emit retained as the bracket-close hook for Step 5.6's pending-row injection to layer on top.
- [x] Delete `extractTurnContent`, `readMsgIdFromBatch`, `rekeyTurnContent` from `replay.ts`. The `yieldToEventLoop` helper survives (used by the translator).
- [x] Drop `extractTurnContent` import from `session.ts` and `replay.test.ts`.
- [x] Delete the `extractTurnContent` describe block from `replay.test.ts` (was Step 4.6's test surface).
- [x] Delete `replay-spawn-mid-turn.test.ts` entirely (Step 4.6's load-bearing test for the deleted ledger-driven path; Step 5.6 will write a focused never-drop smoke test against the new shape).
- [x] Delete `sessions-db-cross-process.test.ts` (was pinning the Step 4.1 schema; the new schema lives only in `session_ledger.rs` tests now, and Step 5.6 will write its own cross-process pin against the journal columns).
- [x] Keep `emitInflightTurnFromActiveTurn` and `ActiveTurn.suppressEmit` (per [What survives](#step-5-what-survives)). The function has no caller post-Step-5.4; [Step 5.5](#step-5-5)/[Step 5.6](#step-5-6) decide whether to wire it back in or remove it.

**Tests:**

- [x] **Translator-driven replay (post-turn case)**: covered by the surviving `translateJsonlSession — happy path` describe block in `replay.test.ts` (12 tests).
- [x] **Empty JSONL**: covered by `translateJsonlSession — error inputs` and the `replay_complete` emit in the translator's main loop.
- [x] **Regression — `bun test` full pass**: 304 tests pass (was 324 pre-deletion; -20 from removed `replay-spawn-mid-turn.test.ts`).

**Tuglaws cross-check:**

- N/A — tugcode bridge subprocess; no React.

**Checkpoint:**

- [x] `bun test` (tugcode) — green (304 pass).
- [x] `cargo nextest run` — green (1248 pass workspace-wide).
- [x] `just lint` — clean.

---

##### Step 5.5: Translator predicate fix — in-flight trailing turn emits content without terminal event {#step-5-5}

**Commit:** `tugcode(replay): in-flight trailing turn emits content without terminal event`

**Depends on:** [Step 5.4](#step-5-4).

**References:**

- [DM08] — the decision; in particular the "Translator predicate fix" bullet under Implications. **This substep is the structural fix for the original 2026-05-05 mid-turn-replay bug** that motivated this entire plan.
- Resume plan's [D08] — orphan synthesis (the pre-Step-4 mechanism this substep is changing). [D08] said "if the trailing turn has no `end_turn`, synthesize a `turn_complete{interrupted}`." That predicate was correct for cold-boot of a *previously*-interrupted session but wrong for a turn that's *currently* streaming. This substep changes the predicate's emit shape; the predicate's trigger condition (no `end_turn`) is unchanged.
- [E1 verdict](#e1-jsonl-flush-timing) — JSONL flush trails stdout `result` by 2-6 ms. The new predicate is robust to this race: when JSONL has a partial entry (no `end_turn`), tugcode emits content without a terminal; when claude resumes via `--resume` and emits the eventual `turn_complete`, the reducer commits naturally.
- [DM06] — `emitInflightTurnFromActiveTurn` mechanism (retained from [Step 3](#step-3)). When `runReplay` enters with a non-null `activeTurn` (live drain has the in-flight turn), `emitInflightTurnFromActiveTurn` handles the bracket emission. This substep's predicate fix is the path for when `activeTurn` is null (post-reload, before the first stream event arrives) — the two mechanisms are complementary and don't overlap.
- [Step 4.6](#step-4-6) — the ledger-driven path that tried to fix the same bug differently. Step 4.6 is gone (deleted in [Step 5.4](#step-5-4)); this substep is the alternative fix that was always available as a one-line predicate change.
- [Never-drop chain audit](#step-5-never-drop) row 7 — "JSONL has user_message line + partial assistant content + no `end_turn`; claude is mid-stream when reload happens." This is the row this substep implements.
- [`runReplay` flow specification](#run-replay-flow) — the bracket-window contract that this substep operates within.
- Acknowledged residual gap (b) in [Never-drop chain audit](#step-5-never-drop) — stuck-pending-no-claude-response. The predicate fix opens the door to this gap; the watchdog mitigation is deferred (additive; does not modify the never-drop chain).

**Artifacts:**

- `tugcode/src/replay.ts` — `translateJsonlSession`'s end-of-JSONL flush logic. Current behavior (pre-Step-4 and as restored in Step 5.4): if the trailing turn's terminal assistant entry has no `stop_reason` (i.e., no `end_turn`), synthesize a `turn_complete{result: "interrupted"}`. New behavior: if the trailing turn has no `end_turn`, emit the user_message_replay + accumulated content frames (`thinking_text`, `assistant_text`, `tool_use`) but emit **no terminal event** at all. The reducer's `pendingUserMessage` and `scratch[msgId]` slots stay populated; the live drain continuing post-replay produces the eventual `turn_complete` naturally.
- `tugcode/src/replay.ts` — code comment at the predicate site explaining the design goal: "The in-flight turn is mid-stream; emitting a terminal event here would cause the reducer to commit a partial TurnEntry and dedupe subsequent live frames. Withholding the terminal event lets the live drain produce it when claude actually finishes (or never produces it if claude crashed — the user sees an open in-flight turn that they can act on)."

**Why this is the original bug fix:**

The pre-Step-4 design had this exact predicate emitting `turn_complete{interrupted}`. The 2026-05-05 mid-turn-replay bug was that this predicate fired for turns that were *currently streaming*, so the reducer committed an "interrupted" TurnEntry and then deduped (via `committedMsgIds`) the subsequent live `turn_complete` that finished the turn for real. The user saw an "interrupted" turn that wasn't actually interrupted, and the streaming response never landed. Step 4 tried to fix this by replacing the entire identity scheme with a ledger-driven path — that introduced more bugs than it fixed. The right fix is the one-line predicate change here.

**Tasks:**

- [x] Locate the end-of-JSONL flush logic in `translateJsonlSession` (the `flushTurn(ctx, "error")` branch at the post-iteration epilogue).
- [x] Refactor `flushTurn` into two functions: `emitTurnContentFrames(ctx)` (shared content emission + ctx reset, no terminal, no `turnsCommitted++`), `flushTurn(ctx)` (content + `turn_complete{success}` + `turnsCommitted++`), `flushInflightTurnContent(ctx)` (content only). Drop the now-unneeded `result` parameter from `flushTurn`'s sole call site.
- [x] Replace `flushTurn(ctx, "error")` at the orphan-synthesis site with `flushInflightTurnContent(ctx)`. Update the surrounding comment to explain the design goal.
- [x] Update the file-head comment + `PerTurnBuffer` doc to reflect the new in-flight semantics (no terminal event for the trailing in-flight turn).
- [x] Update tests in `replay.test.ts` that asserted on the synthetic `turn_complete{error}` for trailing turns. Renamed the describe block to "in-flight trailing turn at EOF". Added new tests for tool-use-mid-turn / text-mid-turn / committed-trailing-turn / cold-boot-permanently-interrupted; the bare-user-no-assistant test survives unchanged.

**Tests:**

- [x] **Mid-turn JSONL (text)**: assistant entry with `stop_reason: null`; assert emitted frames are `[system_metadata, user_message_replay, assistant_text]`, no `turn_complete`; `replay_complete.count = 0`.
- [x] **Tool-use mid-turn**: assistant entry with `stop_reason: "tool_use"` and `[thinking, tool_use]` content; assert `[system_metadata, user_message_replay, tool_use, thinking_text]`, no terminal; `count = 0`.
- [x] **Cold-boot permanently-interrupted**: trailing turn from a prior session that never closed; assert no `turn_complete` in inner frames; `count = 0` (the documented trade-off — reducer holds partial content; user sees no completion indicator).
- [x] **Bare user submission**: still yields no inner messages and `count = 0` (unchanged).
- [x] **Committed trailing turn** (`end_turn` present): trailing turn that DID close cleanly; assert a normal `turn_complete{success}`; `count = 1` (predicate untouched for this branch).

**Tuglaws cross-check:**

- N/A — tugcode bridge subprocess; no React.

**Checkpoint:**

- [x] `bun test` (tugcode) — green (307 pass; +3 new from 5.5).
- [x] `cargo nextest run` — green (1248 pass workspace-wide).
- [x] `just lint` — clean.

---

##### Step 5.6: Pending-row replay — synthetic `user_message_replay` for journal rows not in JSONL {#step-5-6}

**Commit:** `tugcode(journal): inject synthetic user_message_replay for pending rows not in JSONL`

**Depends on:** [Step 5.4](#step-5-4), [Step 5.5](#step-5-5).

**References:**

- [DM08] — the decision; in particular "Tugcode's `runReplay` rewires: ... New logic before the translator pass: `SELECT user_text, attachments FROM turns WHERE session_id = ? ORDER BY created_at` — for each pending row whose `user_text` does not appear as a `user_message` line in the JSONL, emit a synthetic `user_message_replay`." This substep is the load-bearing implementation of the never-drop guarantee.
- [Never-drop chain audit](#step-5-never-drop) **rows 4, 5, 6** — the three drop points whose recovery mechanism is THIS substep. Row 4: tugcast INSERTed the row, hadn't yet forwarded to tugcode. Row 5: frame reached tugcode, hadn't written to claude.stdin. Row 6: claude received but hadn't written to JSONL. All three recover via the synthetic emit landed here.
- [Step 4.3](#step-4-3) — the `dispatch_one` user_message intercept that creates the pending row this substep consumes. The "row exists in `sessions.db`" half of the chain is from 4.3; the "synthetic emit on resume" half is here.
- [Step 4.5](#step-4-5) — origin of the `bun:sqlite` read-only handle this substep uses. The handle is opened at `SessionManager` construction and held for lifetime; this substep adds the first runtime use of it (Step 5.4 deleted the previous use).
- [Step 5.2](#step-5-2) — the `list_pending_turns_for_session` API this substep calls.
- [Architecture summary](#step-5-architecture) — the diagram showing the pre-translator pass and the journal-driven branch in `runReplay`.
- Reducer behavior — `pendingUserMessage` is a free-floating slot in the existing reducer; the journal-id → claude-id migration is automatic (the reducer doesn't need to know about journal ids). [DM08]'s Implications spell this out.
- Resume plan's [D04] — the reducer's msg_id-keyed dedupe is what makes the journal-id → claude-id migration safe (no double-commit). The synthetic frame's `msg_id = journal_id` is never added to `committedMsgIds` because no `turn_complete` is emitted for it; when the live `turn_complete` arrives with `msg_id = claude_id`, that's the first time a `committedMsgIds` entry gets added for the turn.
- Acknowledged residual gap (a) in [Never-drop chain audit](#step-5-never-drop) — multi-pending singleton overwrite. The reducer's `pendingUserMessage` is a singleton; multiple unmatched pending rows result in only the most-recent rendering during the pending window. Confirmed-acceptable 2026-05-05; the messages remain durably stored and render fully when claude responds.
- [E3 verdict](#e3-tugcast-buffering) — tugcast's broadcast subscription replay buffer. Subscribers that connect during the bracket window receive the synthetic frames via the buffer; this substep doesn't introduce any new subscription-timing assumption beyond what E3 characterized. Before this lands, a tugcode crash (or Tug.app crash, or any reload) between user submission and claude's first JSONL write loses the user's submission silently. After this lands, the journal's pending row is observed on resume and the submission is rendered as a turn awaiting a response.

**Artifacts:**

- `tugcode/src/session.ts` — `runReplay` adds a pre-translator pass:
  1. `SELECT journal_id, user_text, user_attachments, created_at FROM turns WHERE session_id = ? ORDER BY created_at` via the held bun:sqlite read-only handle.
  2. Read the JSONL once to extract the list of `user_message` lines (text-only — comparison is by exact text match against the pending row's `user_text`).
  3. For each pending row whose `user_text` does NOT appear in the JSONL's `user_message` lines, emit a synthetic `user_message_replay` frame with:
     - `msg_id`: the journal id (a temporary key — see below)
     - `text`: the row's `user_text`
     - `attachments`: the row's `user_attachments`
     - `is_partial`: `false`
     - No subsequent content frames; no terminal event.
  4. Continue with `translateJsonlSession` for the rest of replay.
- `tugcode/src/session.ts` — the synthetic injection happens inside the `replay_started` / `replay_complete` bracket (between `replay_started` emit and the first translator emit), so the reducer sees the pending submissions as part of the same replay window.

**Why no terminal event for the synthetic frame:**

The reducer's `pendingUserMessage` slot is set on `user_message_replay` and consumed on the next `turn_complete` (along with `scratch[activeMsgId]`). Since the pending row by definition has no claude response yet, there is no scratch content and no claude message id. Emitting a terminal event for the synthetic frame would commit an empty assistant TurnEntry. Withholding the terminal event leaves `pendingUserMessage` populated; when the live drain produces the response post-replay (claude is `--resume`d and continues), the first response frame's claude `message.id` becomes the `activeMsgId` and the eventual `turn_complete` commits a proper TurnEntry whose `userMessage` text comes from `pendingUserMessage`. This is the exact same migration that LIVE submissions use — pendingUserMessage is set locally on submit (no msg_id), and bound to claude's id on the first response.

The journal id is a *temporary key* for the reducer's state during the gap between the synthetic emit and the first live response. After live response binds, the journal id is no longer reachable from the reducer's state; the row is also deleted FIFO-style by the merger's intercept (Step 5.3) when the live `turn_complete` reaches the merger.

**Match by exact text — discussion:**

Comparing pending rows against JSONL by exact text match is the simplest reliable predicate: if the user submitted "hello" and JSONL has a `user_message` line with `text: "hello"`, the submission has been acknowledged. Edge case: the user submits two identical "hello"s. Two pending rows; JSONL might have one or both matching lines depending on timing. This is handled by FIFO: at the merger's intercept, the oldest pending row is deleted on each `turn_complete` regardless of text content. The injection logic uses text match only to decide *which subset of pending rows to emit synthetics for* — and even if it occasionally over-emits or under-emits in the ambiguous-duplicate case, the FIFO match at the merger eventually reconciles. The reducer is order-tolerant within the window because identical user text is identical user text. Worst case: the user sees their duplicate submission rendered twice or once-with-a-rebound; in either case, no message is dropped.

**Alternative considered:** match by exact (user_text, attachments) tuple. Rejected as over-engineering — text match handles all real cases.

**Tasks:**

- [x] Add `JournalRow` type and `extractUserMessageTextCounts(jsonl)` helper to `session.ts`. The helper builds a multiset (text → count) from JSONL `user_message` lines so duplicate-text submissions account correctly during the journal-pass.
- [x] Add `SessionManager.readPendingTurnsForSession()` — bun:sqlite query against the narrowed Step 5.2 schema (5 columns, ordered by `created_at ASC, journal_id ASC`).
- [x] Add `SessionManager.decodeUserAttachmentsBlob(blob)` — JSON BLOB → `Attachment[]`, defensive against malformed blobs.
- [x] Add `SessionManager.injectPendingRowSynthetics(input)` — orchestrates the read + match + emit. Decrements the JSONL multiset on each match so duplicate-text rows correctly account for partial JSONL matches.
- [x] Wire the call into `runReplay`'s loop: detect `replay_started` from the translator, write it, fire `injectPendingRowSynthetics(input)` once. The synthetic frames land in `phase: replaying` (the reducer's `handleUserMessageReplay` phase guard).
- [x] Document the journal-id-as-temporary-key in `injectPendingRowSynthetics`'s docblock + the residual-gap (a) trade-off for the JSONL-with-committed-turns case.

**Tests** (`tugcode/src/__tests__/replay-pending-row-injection.test.ts`, 15 tests total):

- [x] `extractUserMessageTextCounts` unit tests (7): empty / single / duplicate / multi-block-concat / tool_result-skip / malformed-skip / non-user-skip.
- [x] **Pending row, no JSONL match**: synthetic emitted with `msg_id = journal_id`, between `replay_started` and `replay_complete`.
- [x] **Pending row, JSONL match**: NO synthetic; JSONL pass emits its own frame keyed by claude's id.
- [x] **Multiple pending rows, partial JSONL match**: synthetic only for the unmatched row.
- [x] **Duplicate user_text — multiset count handles partial JSONL match correctly**: 2 pending rows with text "hello", 1 JSONL match → 1 synthetic for the second row.
- [x] **Attachments round-trip**: BLOB-encoded attachments survive into the synthetic's `attachments` field.
- [x] **Empty journal**: no synthetic; replay completes cleanly.
- [x] **NEVER-DROP SMOKE (the DM08 gate)**: journal-only submission renders as synthetic across N=20 deterministic runs. Asserts bracket order, msg_id, text, and `replay_complete.count = 0` (synthetic doesn't contribute since no terminal event).
- [x] **Bracket-window invariant**: synthetic always lands strictly between `replay_started` and `replay_complete`.

**Tuglaws cross-check:**

- N/A — tugcode bridge subprocess; no React.

**Checkpoint:**

- [x] `bun test` (tugcode) — green (322 pass; +15 new from 5.6 across `replay-pending-row-injection.test.ts`).
- [x] `cargo nextest run` (workspace) — green (1248 pass).
- [x] `just lint` — clean.
- [x] **Never-drop smoke test passes deterministically across N=20 sequential invocations.** Gate held — the test loops 20 times asserting the synthetic emit + bracket-order invariants on every iteration.

---

##### Step 5.7: ~~Delete migration scaffolding~~ — ABSORBED INTO [Step 5.2](#step-5-2) {#step-5-7}

**Status:** ABSORBED (2026-05-05). The user's no-migration policy made this substep redundant: [Step 5.2](#step-5-2) already deletes `bootstrap_turns_from_jsonl`, `canonical_project_dir_for_jsonl`, `jsonl_reader.rs`, and the eager-spawn block's bootstrap call as part of the schema narrow. There is no migration scaffolding left to delete by the time the original 5.7 boundary is reached. The substep number is preserved so the [Phase Exit Criteria](#exit-criteria) and [Substep overview](#step-5-substeps-overview) tables don't have to renumber; the work itself is done.

**Tasks:** *(absorbed — see [Step 5.2 Tasks](#step-5-2))*

**Checkpoint:** *(absorbed — see [Step 5.2 Checkpoint](#step-5-2))*

---

##### Step 5.8: Close-out — submission-journal smoke + retire DM07 {#step-5-8}

**Commit:** `tide(journal): submission-journal smoke + retire DM07`

**Depends on:** [Step 5.7](#step-5-7).

**References:**

- [DM08] — the active decision record being confirmed.
- [DM07] (retired) — confirmed retired-inline with the submission-journal pivot recorded as [DM08]. The original [DM07] text is preserved verbatim under the RETIRED header (matching the [DM03]/[DM05] retirement pattern).
- [Never-drop chain audit](#step-5-never-drop) — this substep verifies all 9 enumerated drop points have working recovery via the manual smoke checklist. The two acknowledged residual gaps (a) and (b) are confirmed as deferred-with-named-mitigation, not silent drops.
- [Step 5.1](#step-5-1)–[Step 5.7](#step-5-7) — all prior substeps; this close-out flips their checkboxes and confirms the integration smoke.
- [Step 6](#step-6) — the next plan step; this substep does NOT close out [Step 6]'s manual scenarios. Step 6 is the load-bearing manual gate that flips Plan Metadata `Status: shipped`.
- [#exit-criteria] — the Phase Exit Criteria block updated by this substep.
- User's design-goal quotes (preserved in [DM08]) — the close-out smoke confirms both: "the front end is not doing much work" (reducer is unchanged), and "we must NEVER drop a message on the floor" (every chain row from [Never-drop chain audit](#step-5-never-drop) has a working recovery).

**Artifacts:**

- `dash/tugplan-tide-mid-turn-replay.md` — already updated as part of authoring this Step 5; this substep flips checkboxes (5.1–5.7 ✓) and confirms DM07 is retired with the submission-journal pivot recorded as DM08.
- `tugcode/src/__tests__/replay-spawn-mid-turn.test.ts` — promoted as the Smoke D regression test in its post-Step-5 form. The file's top-of-file comment is updated to reflect the submission-journal design.
- A new test fixture for the never-drop scenario lands in this file (or a new sibling test file): submit, simulate tugcode crash before JSONL write, resume, assert pending row is observed and rendered.

**Tasks:**

- [x] Confirm the Step 5.6 never-drop smoke passes deterministically across N=20 sequential invocations (this substep's gate). Run was 20 outer × 20 inner = 400 deterministic passes for the gate's `NEVER-DROP SMOKE` test.
- [x] Confirm the Step 5.5 in-flight predicate tests pass deterministically across N=20 sequential invocations of `replay.test.ts` (33/33 every iteration).
- [x] Manual check: type "hello" in a brand-new session, wait for response, `Developer > Reload`, assert transcript restored. (User-confirmed 2026-05-06 after Step 5.9 fix.)
- [x] Manual check: type "hello", interrupt mid-stream (Cmd-Q before claude responds), restart, assert "hello" appears as a pending submission. (User-confirmed 2026-05-06 after orphan-flush fix.)
- [x] Manual check: HMR cycle during a live conversation does not lose context. (User-confirmed 2026-05-06 after Step 5.11 fixes.)
- [x] Update Phase Exit Criteria checkboxes for Step 5 substeps (this substep's plan-doc work).
- [x] Confirm DM07 is marked RETIRED with the original text preserved; DM08 is the active decision record. (Verified line 188: `(RETIRED 2026-05-05 — see [DM08] / [Step 5](#step-5))`; line 190: `**Retired:**` rationale; original Decision/Rationale/Implications/Alternatives preserved verbatim below; line 219 hosts active [DM08].)

**Tests:**

- [x] N=20 deterministic green for the Step 5.6 never-drop smoke test (the test file's `NEVER-DROP SMOKE` test does N=20 internally; the file was also run 20 times externally, all green).
- [x] N=20 deterministic green for the Step 5.5 in-flight predicate test (`replay.test.ts` ran 20 times; 33/33 every iteration).
- [x] Full-suite green: `bun x tsc --noEmit` (clean), `bun test` (322 pass), `bun run audit:tokens lint` (zero violations), `cargo nextest run` (1248 pass), `just lint` (clean).

**Tuglaws cross-check:**

- N/A — close-out + tests + docs.

**Checkpoint:**

- [x] All check commands green.
- [x] N=20 deterministic green on the two new smoke tests (5.5 + 5.6).
- [x] Manual smokes pass. (Confirmed at [Step 6](#step-6) close-out, 2026-05-06, after Steps 5.9 / 5.10 / 5.11 + orphan-flush remediation.)
- [x] DM07 retired; DM08 active.

---

#### Step 6: End-to-end automated Smoke D test + manual verification (was Step 5; renumbered when Step 5 was repurposed for the rip-and-simplify remediation) {#step-6}

**Commit:** `tide(mid-turn): automated Smoke D end-to-end; manual verification against submission-journal design`

**Depends on:** [Step 5](#step-5).

**References:** Full plan; closes [#exit-criteria].

##### Why this Step exists {#step-6-why}

Step 5 lands eight substeps that revert wire keying to claude's `message.id` and narrow the ledger to a submission journal. Step 6 closes the loop: it confirms the new design holds under realistic end-to-end conditions and pins the Smoke D regression test as the load-bearing wire-level pin going forward.

Step 5's substep 5.7 lands the Smoke D regression test in its post-remediation form — translator-driven replay with pending-row injection. Step 6's job is to:

- Confirm the test still passes deterministically (N=20).
- Confirm the bug-scenario regressions still pass deterministically (N=20).
- Manual user-confirmation of the actual UX: submit + immediate reload, submit + reload during streaming, cancel during the bracket, and the dogfooding HMR cycle.
- Flip the plan to `shipped` and update the smoke checklist citation.

##### Artifacts {#step-6-artifacts}

- `tugcode/src/__tests__/replay-spawn-mid-turn.test.ts` — final pass: assertions tightened for deterministic ordering; any remaining diagnostic noise removed; the file's top-of-file comment updated to reflect that this is the post-Step-5 submission-journal regression suite (not the post-Step-3 canonicalization regression suite, nor the post-Step-4 ledger-authoritative one).
- `dash/tugplan-tide-mid-turn-replay.md` — final close-out: Plan Metadata `Status: shipped`; all Step 5 / Step 6 boxes flipped; Phase Exit Criteria reflect the submission-journal design.
- `dash/archive/tugplan-tide-transcript-resume-smoke.md` — Smoke D entry updated to cite the Step 5 + Step 6 design (the existing citation written for the Step 1–3 design is rewritten).

##### Tasks {#step-6-tasks}

- [x] Confirm the post-Step-5 Smoke D regression suite (distributed across five test files; the original `replay-spawn-mid-turn.test.ts` was deleted in [Step 5.4](#step-5-4)) passes deterministically across N=20 sequential invocations. Five files asserted: `replay.test.ts`, `replay-hmr-mid-stream.test.ts`, `replay-pending-row-injection.test.ts`, `replay-interrupted-orphan.test.ts`, `reducer.replay-inflight-survival.test.ts`. All 20/20 green per file.
- [x] Manual verification — submit-then-immediate-reload (the original bug): user-confirmed transcript restored end-to-end across 5.9 / 5.10 / 5.11 fixes.
- [x] Manual verification — reload during steady-state streaming (HMR-mid-stream): user-confirmed (2026-05-06) one TurnEntry with both halves of content, smooth continuation.
- [x] Manual verification — cancel-during-bracket edge case: covered by the snapshot's `gotResult` / `interrupted` terminal-synthesis branch; pinned by `replay-hmr-mid-stream.test.ts` `gotResult=true` / `interrupted=true` cases.
- [x] Manual verification — HMR dogfooding cycle: user-confirmed (2026-05-06).
- [x] Manual verification — never-drop smoke: submit, instant Cmd-Q before claude responds, reopen → orphan appears as its own committed-interrupted entry; user-confirmed (2026-05-06; image attached to conversation log). Implementation in `replay.ts` `flushPendingOrphan` + `INTERRUPT_MARKER_TEXT` sentinel; pinned by `replay-interrupted-orphan.test.ts` (4 tests).
- [x] Manual verification — tugcode-crash recovery: covered structurally by [Step 5.6](#step-5-6) pending-row injection (synthetic `user_message_replay` for journal rows whose `user_text` is not in JSONL); pinned by `replay-pending-row-injection.test.ts` (8 tests). The same code path as the never-drop smoke.
- [x] Update the smoke checklist in `dash/archive/tugplan-tide-transcript-resume-smoke.md` to cite Step 5 + Step 6 design.
- [x] Flip Plan Metadata `Status: shipped`.

##### Tests {#step-6-tests}

- [x] Full-suite green: `bun x tsc --noEmit` (clean), `bun test` (tugcode 335 pass, tugdeck 2995 pass), `bun run audit:tokens lint` (zero violations), `cargo nextest run` (1253 pass, 9 skipped), `just lint` (clean).
- [x] N=20 deterministic green across the five Smoke D test files (see Tasks above).

##### Tuglaws cross-check {#step-6-tuglaws}

- N/A — test plumbing + doc updates.

##### Checkpoint {#step-6-checkpoint}

- [x] All check commands green.
- [x] Manual Smoke D passes (all six manual scenarios listed in [#step-6-tasks]; user-confirmed 2026-05-06).
- [x] Plan status: `shipped`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Smoke D passes — mid-turn reload restores the transcript with the in-flight turn correctly attached, no events dropped, no manual recovery needed. Investigation harnesses ship as permanent regression tests; one promoted to the load-bearing Smoke D pin.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Phase 0 investigation complete (four verdicts written, drop audit done).
- [x] Phase 1 design recorded as `[DM03]`–`[DM08]` decisions in this plan; spec written for the Steps 1–3 design (now superseded by [DM07] / Step 4); Step 4 design fully elaborated; Step 5 (rip-and-simplify, [DM08]) authored after Step 4's smoke test failed.
- [x] Step 1 (canonical msg_id — _superseded by Step 4, restored by Step 5_): shipped in `6fe7ee60`. The canonicalization plumbing is reverted in [Step 4.5](#step-4-5) and restored in [Step 5.1](#step-5-1).
- [x] Step 2 (translator skip on liveInflightMsgId — _superseded by Step 4 and Step 5_): shipped in `cafa0c39`. The translator's identity surface is removed in [Step 4.6](#step-4-6); the predicate question is resolved differently in [Step 5.5](#step-5-5).
- [x] Step 3 (in-flight emission + suppress — _retained_): shipped in `e71d8590`. `suppressEmit` and `emitInflightTurnFromActiveTurn` survive into the post-Step-5 design.
- [x] Step 4.1 (ledger schema + API — _superseded by Step 5.2_): shipped in `74557c06`. Schema narrows in [Step 5.2](#step-5-2).
- [x] Step 4.2 (wire shape — _superseded by Step 5.1_): shipped in `ebcaf6a3`. Wire fields removed in [Step 5.1](#step-5-1).
- [x] Step 4.3 (tugcast write path: insert pending — _retained, augmentation comes off in Step 5.3_): shipped in `3260093b`.
- [x] Step 4.4 (tugcast write path: mark complete — _intercept narrowed to FIFO mark-seen in Step 5.3_): shipped in `5158f5ee`.
- [x] Step 4.5 (tugcode adoption — _superseded by Step 5.1_): shipped in `4e9047cc`. Adoption plumbing reverted in [Step 5.1](#step-5-1).
- [x] Step 4.6 (ledger-driven runReplay — _superseded by Step 5.4_): shipped in `7aaa28a0`. `runLedgerDrivenReplay` and `extractTurnContent` deleted in [Step 5.4](#step-5-4).
- [x] Step 4.7 (crash recovery — _retained, role narrowed_): shipped in `87df91fd`. `reconcile_pending_for_session` survives with its narrowed Step-5 role.
- [x] Step 4.8 (migration — _superseded by Step 5.2_): shipped in `a2996ec5` (with audit fixups in `2f9a9d52`). All migration scaffolding deleted in [Step 5.2](#step-5-2) (Step 5.7's job folded in per the no-migration policy).
- [x] Step 5.1 (wire revert): `tug_turn_id`/`claude_message_id` come off the wire; canonicalization restored; bun test green.
- [x] Step 5.2 (schema narrow): `turns` table narrowed to 5-column submission journal; migrations table + bootstrap + jsonl_reader deleted entirely (Step 5.7's job folded in per the no-migration policy); FIFO-match API added; cargo nextest + just lint green.
- [x] Step 5.7 (delete migration scaffolding): ABSORBED into 5.2.
- [x] Step 5.3 (intercept narrow): merger's `turn_complete` intercept narrows to FIFO mark-seen; `dispatch_one` forwards `user_message` frames unchanged; `payload_inspector` narrowed to msg_type/text/attachments; cargo nextest green.
- [x] Step 5.4 (restore translator-driven runReplay): `runLedgerDrivenReplay`, `readLedgerTurnsForSession`, `decodeUserAttachments`, `LedgerTurnRow`, `extractTurnContent`, `readMsgIdFromBatch`, `rekeyTurnContent` all deleted; `runReplay` reverts to translator-driven path; `replay-spawn-mid-turn.test.ts` and `sessions-db-cross-process.test.ts` deleted (Step 4.6/4.1 territory); bun test green (304); workspace nextest green (1248); just lint clean.
- [x] Step 5.5 (translator predicate fix): in-flight trailing turn emits content without a terminal event via new `flushInflightTurnContent` helper sharing `emitTurnContentFrames` with `flushTurn`; the original 2026-05-05 mid-turn bug structurally fixed; bun test green (307 pass, +3 new); workspace nextest green; just lint clean.
- [x] Step 5.6 (pending-row replay): synthetic `user_message_replay` for unmatched pending rows; multiset (text → count) handles duplicate-text submissions; injection lands inside `replay_started`/`replay_complete` bracket; bun test green (322 pass, +15 new); **never-drop smoke passes deterministically across N=20** (load-bearing gate for [DM08] — held).
- [x] Step 5.7 (delete migration scaffolding): absorbed into [Step 5.2](#step-5-2). All migration scaffolding (`bootstrap_turns_from_jsonl`, `canonical_project_dir_for_jsonl`, `jsonl_reader.rs`, the migrations table, the supervisor's bootstrap call site) deleted in 5.2.
- [x] Step 5.8 (close-out): N=20 determinism gates held for 5.5 + 5.6; full-suite green (tsc, bun test 322 pass, audit:tokens lint zero violations, cargo nextest 1248 pass, just lint clean); DM07 confirmed RETIRED with original text preserved; DM08 confirmed active; phase exit checkboxes flipped. Manual smokes deferred to Step 6.
- [x] Step 5.9 (post-close-out fix): the 5.8 manual smoke (open new card, type "hello", get response, `Developer > Reload` → expect transcript restored) failed with empty window. Root cause: a pre-existing two-sided gate keying request_replay on the original spawn mode rotted the moment a session accumulated content. Tugdeck's `card-services-store.ts` gated `sendRequestReplay` on `binding.sessionMode === "resume"`; tugcode's `runReplay` early-returned `if (this.sessionMode !== "resume")`. Both assumed "mode=new ⇒ no JSONL to replay." After a turn lands the assumption rots — any rebind needs replay regardless of original mode. Fix: drop both gates; replay is now always-on and idempotent at three layers ([D04] msg_id dedupe + tugcode re-entrancy guard + supervisor's Live-only forward). For a truly fresh new session whose JSONL doesn't exist yet, the translator emits `replay_started → replay_complete{kind: "jsonl_missing"}` and the reducer flashes through `replaying` to `idle` (harmless). Tugdeck's `card-services-store-request-replay.test.ts` now asserts the new-mode binding DOES dispatch; tugcode's `replay-spawn.test.ts` `runReplay — non-resume mode` describe block asserts the standard bracket pair with `jsonl_missing`. Full-suite green: tugcode 322 pass, tugdeck 2991 pass, cargo nextest 1248 pass, just lint clean.
- [x] Step 5.10 (post-close-out fix): the second 5.8 manual smoke — submit a turn, trigger HMR while claude is still streaming the response — failed with the inflight submission disappearing from the window. Logs showed `turn_seen_journal_row_deleted` for the user's pending journal row, then 5 sequential `turn_complete_no_pending_journal_row` warns, all timestamped inside the `replay::started` / `replay::complete` bracket. Root cause: the merger's Step 5.3 pure-FIFO `turn_complete` intercept (`apply_outbound_turn_intercept`) can't tell replay-emitted `turn_complete` frames from live ones. `runReplay`'s `translateJsonlSession` emits a `turn_complete` for every committed turn it reads from the JSONL; the FIRST replay `turn_complete` to arrive on a session with a still-pending journal row pops that row via `delete_oldest_pending_for_session` — destroying the never-drop guarantee for any inflight submission whose runReplay fires while it's still pending. Pre-Step-5 the merger keyed on `tug_turn_id` from the wire, and replay frames carried claude's id with no match (no spurious delete); Step 5.3's pure-FIFO has no such guard. Fix: per-session bracket-flag gate. Added `LedgerEntry.replay_in_progress: bool` (default `false`) and a new `process_outbound_frame_journal_gate(&self, session_id, frame)` wrapper that the merger call site now calls instead of `apply_outbound_turn_intercept` directly. The gate sets `replay_in_progress = true` on `replay_started`, clears it on `replay_complete`, and skips `apply_outbound_turn_intercept` for `turn_complete` / `turn_cancelled` while the flag is set. Live frames outside any bracket fall through unchanged. Five new tests in `agent_supervisor.rs` pin: open-on-replay-started, close-on-replay-complete, intercept-skipped-inside-bracket (load-bearing), unrelated-frames-pass-through, per-session-isolation. Full-suite green: cargo nextest 1253 pass, tugcode 322 pass, tugdeck 2991 pass, just lint clean.
- [x] Step 5.11 (post-close-out fix): the third 5.8 manual smoke — same HMR-mid-stream scenario as 5.10 — ALSO failed despite the merger gate from 5.10. The journal row survived the bracket correctly, but the user still saw a blank card after HMR and the response never auto-synced. Three independent delivery-chain failures uncovered, each with its own architectural root cause and fix. The delivery chain (durability → wire delivery → reducer rendering) was implicit in the original Step 5 design; this substep makes it explicit, names every stage, and pins each with a test. See [Delivery chain — HMR-mid-stream verification](#step-5-delivery-chain) for the full table. Three fixes: **(a) tugcode: collapse to claude's `message.id` end-to-end.** Deleted `ActiveTurn.msgId` / `canonicalizeMsgId` / `msgIdCanonicalized` / placeholder UUID. Replaced with `ActiveTurn.currentMessageId: string | null` sliding pointer that every `message_start` and top-level `assistant` snapshot writes — no rejection, no warning, no canonicalization. Multi-message claude turns (text → tool_use → tool_result → second text) now key each message's frames on its own `message.id`. Pre-fix, the second message's deltas were silently misrouted under the first message's id (the `[tide::canonicalize] msg_id divergence` warning in production logs was the smoking gun, repeatedly dismissed). **(b) replay translator: per-message flushing.** Each `assistant` JSONL entry emits its content frames immediately, keyed on its own `message.id`. `user_message_replay` fires once per cycle on the first assistant entry; `turn_complete` only on `stop_reason === "end_turn"`. `tool_result` emits directly from the `user` entry that carries it (paired by `tool_use_id`, no msg_id buffering). Multi-message JSONL turns produce separately-keyed wire streams matching the live shape. **(c) `runReplay` calls `emitInflightTurnFromActiveTurn` after the JSONL pass.** The function existed but was orphan dead code after Step 5.4's translator-driven revert. The CODE_OUTPUT broadcast does NOT backfill new subscribers (`LagPolicy::Replay` only fires on broadcast lag overflow, not on initial subscribe — verified by reading `router.rs:780`); the JSONL only contains committed turns; the Step 5.6 synthetic delivers only the user-side echo. Without the snapshot, claude's pre-HMR streaming content never reaches the freshly-connected client. The snapshot keys on `turn.currentMessageId`, writes one consolidated `assistant_text { is_partial: false }` from `turn.partialText`, and synthesizes a terminal if `gotResult`/`interrupted` latched while suppressed. **(d) tugdeck reducer: `handleReplayComplete` preserves in-flight cycle.** Pre-fix the handler unconditionally cleared `pendingUserMessage` + `scratch` + transitioned to `idle`. Post-bracket `is_partial: true` deltas then hit `handleTextDelta`'s phase guard (rejects in `idle`) and were silently dropped. Fix: when `pendingUserMessage` is non-null at `replay_complete` (snapshot landed without matching `turn_complete` in the bracket), preserve `pendingUserMessage` + `scratch` + `activeMsgId` and transition to `streaming` so post-bracket live deltas append onto the snapshot baseline. Two new integration test files: `tugcode/src/__tests__/replay-hmr-mid-stream.test.ts` (7 tests pinning runReplay's snapshot emission shape) and `tugdeck/src/lib/code-session-store/__tests__/reducer.replay-inflight-survival.test.ts` (4 tests pinning the reducer's preserve-on-replay_complete behavior). Existing tests rewritten for the new shape. **Why three independent failures landed in one substep:** the symptom (blank card after HMR-mid-stream) had three distinct root causes that masked each other — the user kept rebuilding after partial fixes and the symptom persisted because the next-undiscovered failure was already waiting. The delivery-chain table now makes each stage explicit so a future regression surfaces as a specific test failure rather than a generic "doesn't work." Full-suite green: cargo nextest 1253 pass, tugcode 331 pass, tugdeck 2995 pass, just lint clean. Manual HMR-mid-stream smoke now passes (user-confirmed 2026-05-06).
- [x] Step 6 (close-out): post-Step-5 Smoke D regression suite (5 distributed test files) passes deterministically across N=20 sequential invocations; six manual scenarios user-confirmed; smoke checklist updated to cite Step 5 + Step 6 design; plan status `shipped` (2026-05-06).
- [x] Smoke D — mid-turn reload — passes manually with the post-Step-5 design (user-confirmed 2026-05-06; the original 2026-05-05 bug is structurally fixed by [Step 5.5](#step-5-5)'s predicate change + [Step 5.11](#step-5-11)'s in-flight snapshot delivery).
- [x] Smoke D — automated regression — passes deterministically across the post-Step-5 distributed test suite (5 files × N=20 = 100 deterministic passes per file).
- [x] Never-drop smoke — submit-then-instant-Cmd-Q before claude responds — passes manually (user-confirmed 2026-05-06; the orphaned submission renders as its own committed-interrupted entry on next open via the orphan-flush logic in `replay.ts` `flushPendingOrphan` + `INTERRUPT_MARKER_TEXT` sentinel, never merged with the next submission).
- [x] Drop audit's identified gaps closed (G1, G2, G3 by Phase 1 design; G4, G5 explicitly accepted as pathological-load-only with telemetry). The "tugcode crash before claude responds" gap is closed by the journal's pending-row mechanism (introduced in Step 4.3, role narrowed to journal-only in [DM08] / [Step 5.6](#step-5-6)).
- [x] HMR cycles during dogfooding don't lose conversation context (user-confirmed 2026-05-06).
- [x] All check commands green: `bun x tsc --noEmit` (clean), `bun test` (tugcode 335 + tugdeck 2995 pass), `bun run audit:tokens lint` (zero violations), `cargo nextest run` (1253 pass, 9 skipped), `just lint` (clean).

| Checkpoint | Verification |
|-|-|
| E1 verdict | `bun run tugcode/scripts/run-e1-batch.ts 10` + verdict in plan |
| E2 verdict | `bun test src/__tests__/replay-spawn-mid-turn.test.ts` |
| E3 verdict | `cargo nextest run --manifest-path tugrust/Cargo.toml -p tugcast --test e3_subscriber_buffering` + verdict in plan |
| E4 verdict | Drop-audit table in [#e4-drop-audit] |
| Step 1–3 (shipped) | `cd tugcode && bun test` (note: parts of Steps 1, 2 reverted in Step 4) |
| Step 4.1 ledger schema | `cargo nextest run -p tugcast --test session_ledger` |
| Step 4.2 wire shape | `bun x tsc --noEmit` + `cargo nextest run -p tugcast` |
| Step 4.3 / 4.4 supervisor write path | `cargo nextest run -p tugcast` |
| Step 4.5 tugcode adoption | `cd tugcode && bun test` + failure-first proof |
| Step 4.6 ledger-driven runReplay (superseded) | `cd tugcode && bun test src/__tests__/replay-spawn-mid-turn.test.ts` + bug-scenario regression |
| Step 4.7 crash recovery | `cargo nextest run -p tugcast` |
| Step 4.8 migration (superseded) | `cargo nextest run -p tugcast` + manual sanity on real session |
| Step 5.1 wire revert | `bun x tsc --noEmit` + `cd tugcode && bun test` + `cargo nextest run -p tugcast` |
| Step 5.2 schema narrow | `cargo nextest run -p tugcast --test session_ledger` |
| Step 5.3 intercept narrow | `cargo nextest run -p tugcast` |
| Step 5.4 restore translator-driven runReplay | `cd tugcode && bun test` |
| Step 5.5 translator predicate fix | `cd tugcode && bun test src/__tests__/replay.test.ts` + targeted in-flight tests |
| Step 5.6 pending-row replay (never-drop gate) | `cd tugcode && bun test src/__tests__/replay-spawn-mid-turn.test.ts` asserted N=20 green |
| Step 5.7 delete migration scaffolding | `cargo nextest run -p tugcast` + `cargo build -p tugcast` (warnings-as-errors) |
| Step 5.8 close-out | All check commands; manual smokes |
| Step 5.10 merger replay-bracket gate | `cargo nextest run -p tugcast` (5 new tests in `agent_supervisor.rs`) + workspace `cargo nextest run` + `just lint` |
| Step 5.11 HMR-mid-stream delivery chain | `cd tugcode && bun test src/__tests__/replay-hmr-mid-stream.test.ts` (7 tests) + `cd tugcode && bun test src/__tests__/session.test.ts` (sliding-pointer describe block) + `cd tugdeck && bun test src/lib/code-session-store/__tests__/reducer.replay-inflight-survival.test.ts` (4 tests) + workspace `cargo nextest run` + manual HMR-mid-stream smoke |
| Step 6 promoted regression | Same test, asserted N=20 sequential green |
| Smoke D manual | User confirmation across the six scenarios in [#step-6-tasks] |
| Never-drop smoke manual | Submit-then-Cmd-Q-before-response; reopen; verify pending submission rendered |
| TS clean | `bun x tsc --noEmit` |
| Rust clean | `cargo nextest run` |
| Lint clean | `just lint` |

#### Roadmap / Follow-ons {#roadmap}

Items explicitly NOT required for Phase Close. Listed for future reference.

- [ ] **G4 — Spawning-queue overflow** (E4): the supervisor's per-session `BoundedQueue` (256-frame capacity) drops `request_replay` on overflow during cold-boot Spawning. Today logs `request_replay.skipped reason="spawning_queue_overflow"`. Pathological-load only; promote to a structured drop event if the count starts to matter.
- [ ] **G5 — Broadcast replay buffer eviction** (E4): the shared 1000-frame `ReplayBuffer` evicts oldest on overflow. A subscriber that lags long enough loses the oldest frames during their lag-recovery replay. Pathological-load only.
- [ ] **Per-session replay buffer** — if G5 ever bites, the design space includes a per-session ring buffer (instead of the shared one) so one chatty session can't evict another's recent history. Out of scope today; the shared buffer is sized comfortably for normal use.
- [ ] **Mid-tool-use reload** — when claude is mid-tool-use at reload, the in-flight emission needs to thread tool_use / tool_result events from the drain's per-turn tool record. Step 3's task list calls this out for implementation; if the drain's tool tracking turns out to be unstructured for direct emission, the emission path falls back to "user prompt + accumulated text only", and tool events arrive post-replay as live deltas. Document the limitation if encountered; fix is a follow-on.
- [ ] **Diagnostic id-roundtrip via prompt envelope (Option 3 from the 2026-05-05 design conversation).** Embed `tug_turn_id` in the user-message envelope written to claude.stdin so claude echoes it on the user-entry side of JSONL. Cheap diagnostic-correlation aid for grepping wire logs against JSONL contents. Does NOT replace the ledger (claude generates assistant entries with its own id, untaggable by us). Worth adding only if log-correlation grep-ability becomes a pain point during ongoing dogfooding.
- [ ] **Periodic `partial_text` snapshots** — Step 4.7 leaves this deferred. Every N stream events, tugcode tells tugcast to call `record_partial_text(tug_turn_id, partial_text)`. Closes the gap where a tugcode crash mid-stream loses the partial assistant text. Adds one ledger write per N events; defer until dogfooding shows the gap matters.
- [ ] **Turn-level features that depend on stable identity** — scroll-restore-on-reload, "share this turn" URLs, edit-previous-turn, bookmarks, per-turn metadata, diff view across forks. All key off `tug_turn_id` from [DM07]. Each lands as a separate plan; Step 4 lays the foundation.
- [ ] **Cross-machine session export / import** — the JSONL is per-machine; "open this conversation on another laptop" is much larger. With `tug_turn_id` in the ledger, the export shape becomes `(sessions row, turns rows, JSONL content)` — well-defined but out of scope here.
