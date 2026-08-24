<!-- tugplan-skeleton v2 -->

## Tide session wake after spontaneous external trigger {#tide-session-wake}

**Purpose:** Tide's transcript paints assistant turns that resume claude from idle — Monitor timeouts, Bash/Task `run_in_background` completions, and harness-fired `ScheduleWakeup` / `CronCreate` timers. Without this work, claude continues processing the wake on its side but the resumed text never reaches the user's screen.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | Closed (Slices 1 + 1c-b shipped through Step 5.8; Slice 2 — Steps 6-9 — deferred; Step 10 integration ceremony skipped). Straggling wake issues are picked up ad-hoc as they surface during further Tide card work. |
| Target branch | main |
| Last updated | 2026-05-25 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

When claude is between turns and goes idle, certain tools can resume it without a user submission:

- **Monitor** — when the watched file matches or the timeout fires
- **Bash** / **Task** with `run_in_background:true` — when the background process exits (and claude idle-waits rather than actively polling via BashOutput/TaskOutput)
- **ScheduleWakeup** — when the requested delay elapses
- **CronCreate** — when the registered cron expression matches the current time

Each of these resumes claude with a synthetic user_message that drives an assistant turn. Tide must show that turn in the transcript.

#### Strategy {#strategy}

- tugcode is the wake detector — observe claude's stream-json stdout, recognize wake-bracket signals, emit a single `wake_started` IPC frame to tugdeck.
- tugdeck's reducer treats `wake_started` as the start of a new turn (a `waking` phase) that closes implicitly on the next `turn_complete`.
- One bracket on the wire for two distinct wake-trigger sources (in-invocation task notifications and harness-fired re-inits) — the reducer cannot tell them apart and doesn't need to.
- Transcript treats wake turns as single-row entries (the wake carries no user-typed text, so there is no "You" bubble to render). Slice 1c-b lifts this to a full sequence substrate ([D07]) — reducer scratch, streaming PropertyStore paths, snapshot, and data source all model a turn as an ordered sequence of typed Messages; the wake's natural absence of a `user_message` Message replaces the sentinel.
- No tugcode-side scheduler. Claude Code's built-in scheduler is the source of truth for ScheduleWakeup / CronCreate timing; tugcode only reacts to its fire signal.
- Slice 2 layers trigger-aware chrome on top of the bracket: tugcode buffers `ScheduleWakeup` / `CronCreate` tool_use payloads in a per-session FIFO ([D08]) and drains them when a Cohort B wake fires, producing a chip-class UI element ([D09]).
- Wake-trigger metadata persists out-of-band via a sidecar JSONL ([D10]) so cold-boot rehydration paints the same chrome as live.
- Tide-side cancellation routes through claude's user_message back-channel ([D12]) — there is no host-initiated tool-call channel in stream-json mode.

#### Success Criteria (Measurable) {#success-criteria}

**Slice 1 (shipped):**

- A Monitor invocation with a 5-second timeout paints its resumed text in the transcript without reopening the session.
- A `ScheduleWakeup delaySeconds:60` paints its wake response in the transcript (at the next minute boundary after `now+60s`, per the harness's documented behavior).
- A `CronCreate` (one-shot and recurring) paints each scheduled fire as a wake turn; the user's CronDelete cancels further fires.
- No wake turn renders with a phantom "You" bubble above it.
- The user can interrupt a runaway wake turn via the Stop affordance.

**Slice 1c-b + Slice 2 (in flight):**

- Reducer, streaming substrate, snapshot, and data source all model a turn as a sequence of typed Messages ([D07]). Wire interleaving (text → tool → text) commits as `[AssistantText, ToolUseMessage, AssistantText]` rather than a flattened single string. The empty-text wake sentinel ([D06]) is gone from every site. All existing transcript / reducer / replay tests pass against the new shape.
- Each wake turn paints with a chip identifying its trigger kind (Monitor / Scheduled / Cron) and a click-expand detail panel.
- After closing and reopening a session, wake turns retain the same chip and detail content (no metadata loss across rehydration).
- A wake fired by `ScheduleWakeup` / `CronCreate` renders its registered prompt as a subdued `system_note` row above the assistant's response.
- The user can cancel a recurring scheduled task by right-clicking its chip and choosing "Cancel"; no further fires arrive over a 3-minute hold.

#### Scope {#scope}

**Slice 1 (shipped):**

1. tugcode wake detection for in-invocation tools (Monitor / Bash runbg idle / Task runbg idle) — `system/task_notification` arm.
2. tugcode wake detection for harness-fired tools (ScheduleWakeup / CronCreate) — `system/init` re-bracket arm.
3. tugdeck reducer + store wrapper handling of the `wake_started` bracket and its `waking → idle` close on `turn_complete`.
4. Transcript data source treats wake turns as single-row entries (via [D06] interim sentinel).

**Slice 1c-b + Slice 2 (in flight):**

5. Lift the turn model to a full sequence substrate ([D07]): reducer scratch holds `Message[]` per active turn, streaming PropertyStore paths key per-Message, `TurnEntry` exposes `messages: ReadonlyArray<Message>`, `ToolCallState` retires onto `ToolUseMessage`, `thinking` becomes a Message kind. Removes the [D06] sentinel end-to-end.
6. Trigger-aware chrome — chip renderer above the wake turn keyed on `WakeTrigger.kind`; Cohort B FIFO correlation in tugcode ([D08], [D09]).
7. Replay-translator metadata persistence — sidecar JSONL ([D10]) so rehydration paints the same chrome as live.
8. System-note rendering for the registered scheduled prompt — Cohort B only; carried on `wake_started.wake_trigger.prompt` ([D11]).
9. Tide-side cancellation of recurring scheduled tasks — context-menu affordance on the cron chip routes a hidden user_message ([D12]).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Durable scheduling across tugcode subprocess restart. Harness scheduling is session-scoped by Anthropic's design (*"dies when Claude exits"*); we match that. Resume-mode rehydration of unexpired scheduled tasks does not currently fire — documented upstream limitation per Step 4.
- Cross-session wake delivery (Routines, Desktop scheduled tasks, etc.). Anthropic ships those separately.
- Cancellation of `ScheduleWakeup` (one-shot wakes). No upstream `WakeDelete` tool exists. Step 9 covers `CronCreate` cancellation only.
- Per-fire cancellation of cron occurrences (only the whole cron task can be cancelled).
- Out-of-band correlation IDs between `ScheduleWakeup` / `CronCreate` tool_use payloads and their fires beyond the FIFO heuristic ([D08]). If/when upstream exposes a correlation id, the implementation upgrades; until then the FIFO is the source of truth.

#### Dependencies / Prerequisites {#dependencies}

- Claude Code v2.1.150 or compatible (the Cron* tools require v2.1.72+; `system/task_notification` shape pinned against `@anthropic-ai/claude-agent-sdk/sdk.d.ts:1659-1668`).
- `tugcode/probes/wake-investigation/` captures of claude's stream-json wire (committed; reproducible via `probe-harness.mjs`).

#### Constraints {#constraints}

- tugcode invokes claude with `--input-format=stream-json --output-format=stream-json --verbose --include-partial-messages --replay-user-messages`. The detector and the bracket close design must operate on the wire shape that mode produces.
- The `wake_started` IPC frame and `WakeTrigger` snapshot field are camelCase tugdeck-side, snake_case tugcode-side. Translate at the reducer boundary.
- tugcode is bun-compiled to a standalone binary (`bun build --compile`). Source edits require an explicit rebuild — there is no HMR.

#### Assumptions {#assumptions}

- The harness scheduler's `system/init` fire signal is a reliable contract for Cohort B. The pattern is empirically observed (`tugcode/probes/wake-investigation/capture-*.stdout`) but not in published SDK documentation. A future Claude Code release that alters the pattern would surface here.
- `system/task_notification` fields used today (`task_id`, `tool_use_id`, `status`, `summary`, `output_file`) remain on the wire. The SDK type declares all of these except `tool_use_id`; the wire emits all five.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Cohort taxonomy (RESOLVED) {#q01-cohorts}

**Question:** Which tools produce wake turns, and what wire signal does tugcode observe for each?

**Resolution:** Three cohorts, two distinct wire signals:

| Cohort | Tools | Wire signal | Handler |
|---|---|---|---|
| **A — in-invocation async** | Monitor; Bash `run_in_background:true` (idle); Task `run_in_background:true` (idle) | `system/task_notification` between turns | `handleTaskNotification` |
| **B — harness re-invoke** | ScheduleWakeup; CronCreate | A fresh `system/init` between turns (claude's built-in scheduler fired its timer) | `handleWakeReInit` |
| **C — not wake sources** | PushNotification (sync outbound); TaskOutput (blocking wait); Task/Bash `run_in_background:true` WITH active poll | n/a | none |

Empirical capture data at `tugcode/probes/wake-investigation/capture-sw-60-*.stdout` and `capture-cron-1m-*.stdout` plus `tugrust/.../v2.1.150-spike/test-{monitor-wake,bash-runbg-wake,task-runbg-idle-wake}.jsonl`.

#### [Q02] Should the wake turn's chrome show what triggered it? (RESOLVED) {#q02-trigger-chrome}

**Question:** When a wake turn paints, should the transcript carry a visible "Resumed by X" cue?

**Resolution:** Yes — chip-class chrome above the assistant text per [D09], populated for Cohort A from the existing `WakeTrigger` snapshot field and for Cohort B from the per-session FIFO ([D08]) that buffers `ScheduleWakeup` / `CronCreate` tool_use payloads. Implemented in Step 6.

Field signal (Session 3702c898): user noted the Stop button flips on during a wake even though the user did not initiate the turn. The chip-class chrome treats wake-initiated turns as a distinct visual class (still interruptible per [Q03], but the chrome signals "spontaneous").

#### [Q03] How should interrupt behave during a wake? (RESOLVED) {#q03-interrupt-during-wake}

**Question:** If the user clicks Stop while a wake turn is streaming, what happens?

**Resolution:** `canInterrupt` is true during `phase === "waking"`. The interrupt frame is identical in shape to a user-initiated interrupt — there is no pending user_message to discard, so the implementation simplification is to call the existing interrupt path. The wake's `turn_complete` (or `turn_cancelled`) closes the bracket.

---

### Risks and Mitigations {#risks}

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Claude Code release changes the `system/init` re-emit pattern (e.g., adds a new mid-turn re-init context that's neither compact nor wake) | low | high | Cohort B detector lives in one place (`handleClaudeLine`). The disambiguation rule is "between-turn re-init = wake, mid-turn re-init = not wake" — pinned by `tugcode/src/__tests__/wake-reinit.test.ts`. Step 4 adds a fixture-replay drift test that catches wire-shape changes earlier. |
| `system/task_notification` SDK type misses fields the wire emits (e.g., `tool_use_id`) | low | low | Existing drift test `tugcode/src/__tests__/wake-sdk-drift.test.ts` pins both compile-time (declared fields) and runtime (wire fields) coverage. |
| Concurrent wakes (Cohort A `task_notification` and Cohort B re-init arriving in close succession) double-bracket on the wire | low | low | Both handlers guard on `this.isInWake` and no-op if a bracket is already open. The reducer also flattens nested wakes at [D01]. |
| Resume-mode session (`--resume`) restores unexpired harness tasks that then fire — same detector applies but is unverified empirically | medium | low | Step 4 manual repro. The detector's heuristic is turn-state-based and doesn't care about session lifecycle, so it should hold. |
| Sequence-substrate rework (Step 5, [D07]) touches reducer state, streaming PropertyStore paths, snapshot shape, and every consumer of `TurnEntry.userMessage` / `.assistant` / `.thinking` / `.toolCalls`. Risks silent transcript regressions and streaming-cell remount cascades | medium | high | Step 5's substrate-only render scope (see [D07] § Render-surface scope) preserves today's visual layout — substrate gains the sequence model but the code row's content rendering surface is unchanged. This shrinks the user-visible blast radius to "did the existing surfaces continue to receive the right data?" Plus: full reducer + transcript-data-source + replay test suite must pass; existing wake / inflight / replay test cases form the regression net; per-Message `messageKey` preserves [L26] mount identity; manual repro of a representative session matrix gates merge. |
| `[D07]` `(msg_id, block_index)` correlation breaks — tugcode forwards an inconsistent index, or wire ordering between `content_block_start` and the first matching delta inverts under partial-message buffering | low | high | Wire contract is verified explicit (every `content_block_delta` carries the same `index` as its opening `content_block_start`). tugcode mapStreamEvent unit tests + drift tests pin the forwarding. A reducer-side defensive guard logs (does not throw) when a delta arrives without a matching mint, surfacing any future tugcode regression at the dev-log without breaking the user's session. |
| IPC contract change (new `content_block_start` event + `block_index` on existing text events) is a wire shape change requiring tugcode rebuild + drift-test updates; downstream consumers that ignored the new fields silently miss the substrate change | medium | medium | Two-commit landing (tugcode first, tugdeck second) keeps the IPC and the substrate decoupled. Tugcode's drift test asserts the new emissions. Tugdeck's reducer treats absence of `block_index` as a fatal dev-log entry (the field is required after Step 5; an old tugcode binary running against new tugdeck would surface immediately). Rebuild + manual repro of the matrix gates Commit 2. |
| Cohort B FIFO ([D08]) misattributes a fire to the wrong scheduled task when multiple ScheduleWakeup tasks register with identical `delaySeconds` | low | low | Documented [D08] edge case; UI chip shows the misattributed prompt rather than the correct one — visible to user; corrective is to query claude. Upgrade path exists if/when upstream exposes a correlation id. |
| Sidecar JSONL ([D10]) and claude's JSONL drift out of sync (e.g., partial write on crash leaves a turn with metadata pointing at a missing turn_index) | medium | low | Sidecar writes use append-only with fsync per record. Replay-translator tolerates orphan sidecar entries (skip + warn) and missing entries (omit chrome). |
| Hidden cancellation user_message ([D12]) produces a visible "Cancelled." assistant turn that leaks into the transcript despite suppression | medium | low | Filter the turn at the tugcode boundary (no `submit_accepted`, drop subsequent `assistant_text` until `turn_complete`). Known limitation noted in Step 9; future polish can prompt-engineer the synthetic message to suppress acknowledgment. |

---

### Design Decisions {#design-decisions}

#### [D01] Bracket pattern with a new `waking` phase {#d01-bracket-pattern}

**Decision:** A new reducer phase `waking` brackets the wake turn. Opened by `wake_started`, closed implicitly by the next `turn_complete` (no separate `wake_complete` frame).

**Rationale:** A wake turn needs a phase distinct from `idle` (so guards that drop assistant text in idle don't fire) and distinct from `submitting`/`streaming` (so submit/interrupt affordances aren't enabled mid-wake unless [Q03] says so). Closing implicitly on `turn_complete` reuses the existing turn-close path — no new wire frame, no new commit code.

Nested wakes flatten to one outer bracket. `handleWakeStarted` arriving while already `phase === "waking"` is treated as an idempotent metadata refresh.

#### [D02] tugcode is the detector, not the reducer {#d02-detector-location}

**Decision:** tugcode owns wake detection. The reducer only knows about the `wake_started` IPC frame.

**Rationale:** The wire shapes that signal a wake (`system/task_notification`, fresh `system/init`) are claude/SDK-specific. Keeping that knowledge in tugcode means the reducer is portable and the SDK's wire-shape evolution is absorbed at the tugcode boundary. The reducer's job is to react to a clean, semantic frame.

#### [D03] Guard loosening is additive {#d03-additive-guards}

**Decision:** Only one existing reducer guard needs to loosen for `waking`-phase events: `handleTextDelta`'s phase check now accepts `idle | streaming | waking` instead of `idle | streaming`. Every other guard remains a drop case; the wake bracket is the sole path that opens an inflight slot for waking.

**Rationale:** Minimum-change defensive policy. Each loosened guard is a new attack surface; one is auditable, more would not be.

#### [D04] Detection in tugcode, not the reducer {#d04-detection-location}

**Decision:** The detector lives in `tugcode/src/session.ts:handleClaudeLine`, which sees every parsed stream-json event regardless of `activeTurn` state.

**Rationale:** Cohort A `task_notification` arrives between turns (`activeTurn === null`); Cohort B re-init can arrive either between turns or mid-turn. The detector must classify correctly in both cases, which requires a single dispatch site that observes every event before turn-routing decides what to do with it.

#### [D05] Cohort B uses claude's harness scheduler — tugcode detects the re-init signal {#d05-reinit-detector}

**Decision:** Claude Code v2.1+ has its own scheduler that fires `ScheduleWakeup` / `CronCreate` timers between turns and emits a fresh `system/init` event to bracket the resulting assistant turn. tugcode does NOT run its own scheduler; it observes the fire signal and opens a wake bracket.

**Disambiguation:** `system/init` is also re-emitted mid-turn after `compact_boundary` events. Distinguish by `activeTurn` state at the time of arrival:

- `activeTurn === null` and `sessionInitSeen === true` → wake fire; emit `wake_started` and open `ActiveTurn`.
- `activeTurn !== null` and `sessionInitSeen === true` → mid-turn re-init (compact); fall through to `dispatchEventToTurn` so the existing `system_metadata` IPC forwarding behavior is preserved.
- `sessionInitSeen === false` → first init; flip the flag and fall through to normal dispatch.

The wake's user_message (the registered prompt) is injected into claude's internal queue and never appears on the stdout wire — tugcode sees only the assistant's response.

**Why no tugcode-side scheduler:** Empirically verified that the harness fires its own timers in stream-json spawn mode (see `dash/archive/wake-investigation-findings.md`). Re-implementing the schedule logic would (a) duplicate work the harness already does, (b) double-fire if both timers run in parallel, and (c) require re-implementing the harness's cron rounding / jitter / DST handling.

#### [D06] Transcript treats wakes as single-row entries {#d06-transcript-wake-single-row}

**Decision:** `TideTranscriptDataSource` detects wake-style `TurnEntry`s (`userMessage.text === ""` and no attachments) and emits ONE row per such turn (the code-row only), not two. The per-turn index math uses an offset-table lookup; the renderer is unchanged.

**Rationale:** Wake turns carry no user-typed text — the empty-text marker is a contract sentinel, not user data. Rendering it as a "You" row produces a phantom user bubble.

**Status:** **Superseded by [D07].** Step 5 retires the sentinel end-to-end:
- The reducer no longer populates `pendingUserMessage` with empty text for wakes (replaced by `pendingTurn` with `isWake: true` and `initialMessages: []`).
- The committed wake `TurnEntry.messages` simply contains no `user_message` Message — iteration yields zero user rows naturally.
- `isWakeTurn` / `isWakeInflight` / `userRowIndexForTurn`'s `-1` sentinel / the offset-table layout machinery all delete.

The sentinel pattern was the right interim shape under Slice 1c-a's constraint that the committed entry be a paired record; [D07] removes that constraint at the substrate level, and the sentinel goes with it.

#### [D07] Full sequence substrate — Message identity, per-Message streaming, ToolCallState retirement {#d07-sequence-substrate}

**Decision:** Reducer state, committed entry shape, streaming substrate, and the data source all model a turn as an ordered sequence of typed Messages. The Message is the unit of identity, mutation, and rendering. Paired-field aggregation (`userMessage` + `assistant` + `thinking`) and parallel storage (`toolCallMap` beside scratch) retire.

**Message union:**

```ts
type MessageKind =
  | "user_message"
  | "assistant_text"
  | "assistant_thinking"
  | "system_note"
  | "tool_use";

interface MessageBase {
  /**
   * Stable React-row identity, minted at Message creation and unchanged
   * through every subsequent mutation (streaming append, tool_result
   * landing on a tool_use, etc.). Derived as `${turnKey}-m${seq}` where
   * `seq` is a monotonic per-turn counter — debuggable and uniqueness
   * is intrinsic to the construction.
   */
  messageKey: string;
  createdAt: number;
}

interface UserMessage extends MessageBase {
  kind: "user_message";
  text: string;
  attachments: ReadonlyArray<AtomSegment>;
  submitAt: number;
}

interface AssistantText extends MessageBase {
  kind: "assistant_text";
  text: string;             // mutates by append during streaming
}

interface AssistantThinking extends MessageBase {
  kind: "assistant_thinking";
  text: string;
}

interface SystemNote extends MessageBase {
  kind: "system_note";
  text: string;
  source: "scheduled" | "compact" | "other";
}

interface ToolUseMessage extends MessageBase {
  kind: "tool_use";
  toolUseId: string;
  toolName: string;
  input: unknown;
  status: "pending" | "done" | "error";
  result: unknown | null;
  structuredResult: unknown | null;
  parentToolUseId?: string;
  toolWallMs: number | null;
}

type Message =
  | UserMessage
  | AssistantText
  | AssistantThinking
  | SystemNote
  | ToolUseMessage;
```

**Reducer state shape:**

```ts
interface ScratchEntry {
  turnKey: string;                                    // canonical turn identity
  messages: Message[];                                // arrival-order sequence across ALL msgIds of this turn
  blockIndex: Map<string, number>;                    // (msg_id + ":" + block_index) → messages array index
  toolCallIndex: Map<string, number>;                 // toolUseId → messages array index
                                                      // (O(1) lookup for tool_result / tool_use_structured)
  systemNoteSeq: number;                              // monotonic counter for system_note messageKey
}

state.scratch: Map<turnKey, ScratchEntry>;            // KEY CHANGE: turnKey, not msgId.
                                                      // One entry per turn; spans every msgId iteration.
state.pendingTurn: PendingTurn | null;                // replaces pendingUserMessage
state.activeMsgId: string | null;                     // latest msgId of the active turn (carried for tool_use_id correlation)
// state.toolCallMap retires (folded into ScratchEntry.toolCallIndex)

interface PendingTurn {
  turnKey: string;
  submitAt: number;
  isWake: boolean;
  initialMessages: Message[];   // [user_message] for handleSend;
                                // [] or [system_note] for handleWakeStarted
}
```

The shift from `Map<msgId, ScratchEntry>` to `Map<turnKey, ScratchEntry>` is the substrate's recognition that a turn is the user-facing unit and a `msg_id` is an internal iteration identifier of claude's tool-use loop. The substrate stops conflating the two.

**TurnEntry shape:**

```ts
interface TurnEntry {
  turnKey: string;
  msgId: string;
  messages: ReadonlyArray<Message>;
  // turn-level metadata unchanged: result, endedAt, wallClockMs,
  // awaitingApprovalMs, transportDowntimeMs, activeMs, ttftMs,
  // ttftcMs, reconnectCount, maxStreamGapMs, turnEndReason, cost
}
```

Removed fields: `userMessage`, `thinking`, `assistant`, `toolCalls`.

**Append-or-mutate rule for text Messages.** Wire-truth-driven:

1. On `content_block_start { msg_id, block_index, kind }`: mint a new Message of `kind` with `messageKey: "${msg_id}-b${block_index}"`; append to `scratch[turnKey].messages`; record the index in `scratch[turnKey].blockIndex.set("${msg_id}:${block_index}", arrayIdx)`. For `kind: "tool_use"`, also index by `tool_use_id` in `toolCallIndex`.
2. On `assistant_text` (or `thinking_text`) delta with `(msg_id, block_index)`: look up the Message via `blockIndex.get("${msg_id}:${block_index}")` and mutate its `text` by append.
3. On `content_block_stop`: no state mutation (marker only; absence-tolerant).
4. On `tool_use` IPC event (later input fill): look up via `toolCallIndex.get(tool_use_id)` and mutate the Message's `input`.
5. On `tool_result` / `tool_use_structured`: look up via `toolCallIndex.get(tool_use_id)` and mutate the Message's `result` / `status` / `structuredResult`.

Wire interleaving is preserved naturally: `text(block 0) → tool_use(block 1) → tool_result → message_start(new msg_id) → thinking(block 0) → tool_use(block 1) → tool_result → message_start(new msg_id) → text(block 0)` produces a `messages` sequence that mirrors the wire exactly — every iteration's thinking and text and tool call land in their wire position. Today's substrate squashes this into one assistant string per msgId AND only keeps the last msgId; tomorrow's preserves the full conversation.

**Tool-use creation guard.** Two wire paths produce tool-use information:

1. `content_block_start { kind: "tool_use", tool_use_id, tool_name }` — opens the block. The handler mints a fresh `ToolUseMessage` with `input: {}`, indexes by `(msg_id, block_index)` in `blockIndex` AND by `tool_use_id` in `toolCallIndex`, appends to `messages`.
2. Subsequent `tool_use` IPC event (the input-fill event tugcode emits after `input_json_delta` accumulates the full input JSON) — the handler looks up via `toolCallIndex.get(tool_use_id)` and MUTATES the existing Message's `input`. It does NOT re-mint. Same pattern for `tool_result` (updates `status` + `result` + `toolWallMs`) and `tool_use_structured` (updates `structuredResult`).

The guard is type-safe: the handler asserts `toolCallIndex.has(tool_use_id)` before mutation; a missed mint (which would indicate a wire-shape regression) surfaces as a fatal dev-log entry rather than a silent re-creation that orphans the original Message.

**Phase machine — transitions unchanged.** The `submitting → awaiting_first_token → streaming` ladder advances on the first text delta (`assistant_text` or `thinking_text`), NOT on `content_block_start`. Block-open is metadata; first delta is the first user-visible content. `handleContentBlockStart` mints the Message and updates indices but does NOT touch phase. This preserves today's TTFT semantics — `firstAssistantDeltaAt` and `firstToolUseAt` still capture the wall-clock of the first user-visible event of each kind.

**Mid-turn replay snapshot pattern (Option 4 — replay-the-stream).** When the WebSocket reconnects mid-turn, tugcode's `emitInflightTurnFromActiveTurn` emits the full event stream that built the active turn up to the snapshot moment, bracketed by the existing `replay_started` / `replay_complete`. The reducer processes these events through the same handlers it uses live and during cold-boot JSONL replay — no special snapshot handler, no snapshot-vs-live branching.

For each Message in the active turn's `messages` array, the snapshot emits the events that the live path would have emitted to produce it:

- `assistant_text` Message → `content_block_start { msg_id, block_index, kind: "text" }` then `assistant_text { msg_id, block_index, text: <full text>, is_partial: false }`.
- `assistant_thinking` Message → `content_block_start { msg_id, block_index, kind: "thinking" }` then `thinking_text { msg_id, block_index, text: <full text>, is_partial: false }`.
- `tool_use` Message → `content_block_start { msg_id, block_index, kind: "tool_use", tool_use_id, tool_name }` then `tool_use { tool_use_id, input: <full input> }`. If the tool has a `tool_result`, emit that next (`tool_result { tool_use_id, output, is_error }`); if it has a `structuredResult`, emit `tool_use_structured` after.
- `user_message` Message (committed turns being rehydrated; not applicable to mid-turn snapshot since the user_message is already on the receiving side) → not emitted in the mid-turn snapshot path. In cold-boot JSONL replay, emitted via the `add_user_message` IPC event (renamed under Step 5.5 from the prior operation-centric `user_message_replay`).

**Reducer-side change: `handleContentBlockStart` is idempotent.** On `content_block_start` for an `(msg_id, block_index)` already present in `scratch[turnKey].blockIndex`: no-op (Message already minted). On new `(msg_id, block_index)`: mint and index. This idempotence is what makes Option 4 work — the live path may have already minted Messages before the disconnect; the snapshot's `content_block_start` for the same `(msg_id, block_index)` must be inert, not duplicate-mint. The same idempotence covers a defensive scenario where a future tugcode regression re-emits a `content_block_start` mid-stream.

The reducer's "REPLACE on `is_partial: false`" idiom from today retires under Step 5. Under the new model, `is_partial: false` for text Messages still means "this is the terminal text for this block" but the reducer treats it as a replace AT THE MESSAGE LEVEL (mutate the Message's text to the full value via shallow-clone) rather than at the scratch-string level. The "live deltas resume after replay_complete" behavior continues to work: subsequent `is_partial: true` deltas append to the now-baselined Message's text.

**Mutation discipline (L02 reference stability).** Mutations follow copy-on-write at the smallest container that changes:

- **Text delta** (assistant_text or thinking_text append): shallow-clone the trailing matching Message with the concatenated text; replace it in the messages array via shallow-clone of the array's trailing slot. All other Messages in the array stay reference-identical. The `ScratchEntry` itself is shallow-cloned for the dispatch.
- **Tool-use mutation** (input fill / tool_result / tool_use_structured): shallow-clone the indexed Message with updated fields; replace it in the messages array via shallow-clone of that slot. Other Messages reference-identical.
- **Append** (content_block_start, system_note prepend): shallow-clone the messages array with the new Message appended (or prepended); existing Messages reference-identical.
- **No in-place mutation of Messages.** A consumer that holds a reference to `messages[3]` from a prior render can safely compare it by reference to the current `messages[3]` to detect changes.

Snapshot identity is Object.is-stable across dispatches that produce no state change. L02 consumers downstream see no churn during quiescence. The pattern mirrors today's `state.scratch` copy-on-write (`const scratch = new Map(state.scratch); scratch.set(msgId, {...existing, [field]: buffer})`).

**Streaming substrate — per-Message PropertyStore paths.** The three fixed channels retire:

| Today | Tomorrow |
|---|---|
| `turn.${turnKey}.assistant` | `turn.${turnKey}.message.${messageKey}.text` (per AssistantText / AssistantThinking) |
| `turn.${turnKey}.thinking` | (same as above) |
| `turn.${turnKey}.tools` | `turn.${turnKey}.message.${messageKey}.state` (per ToolUseMessage, JSON-serialized) |

The `write-inflight` effect carries `messageKey` and `channel: "text" | "state"`. [L26] holds per-Message: `messageKey` is stable from creation through commit; the cell wrapper for that Message subscribes once and retains its source forever.

**Wake handling.** `handleWakeStarted` sets `pendingTurn = { turnKey, submitAt, isWake: true, initialMessages: [...] }`. `initialMessages` is `[]` for a bare wake, or `[SystemNote{prompt}]` once Step 8's `wakeTrigger.prompt` is populated (no separate code path needed in Step 8 — the system_note is just an initial Message). The wake's `messages` never contain a `user_message` Message, so the data source produces no user row. No sentinel.

**`pendingUserMessage` and `snapshot.inflightUserMessage` retire.** Replaced by `state.pendingTurn` (reducer-internal) and `snapshot.activeTurn: ActiveTurnSnapshot | null` (public) exposing `{ turnKey, submitAt, isWake, messages: ReadonlyArray<Message> }`. The data source iterates `activeTurn.messages` for inflight rows, same way it iterates `turn.messages` for committed rows.

**ToolCallState retires.** Its fields move onto `ToolUseMessage`. Tool calls live in `messages` in arrival position; `toolCallIndex` is the O(1) lookup for tool_result handling, pointing into the messages array instead of being parallel storage.

**Rationale.** Three forces make the substrate the right scope:

1. **Wire-shape fidelity.** The wire emits a sequence; today's substrate flattens it. A boundary-translation refactor (paired substrate, sequence at commit) leaves the temporal interleaving — text before a tool call vs. text after — unrecoverable. Future renders can't show what claude actually did because the data is gone.
2. **Extension at the kind level.** Adding a new Message kind under the substrate model is: add a union case, add a handler, add a renderer. The `TurnEntry` shape never changes. Under the boundary model, every new kind needs a new field on `TurnEntry`, a new merge step in `buildTurnEntry`, and consumer updates — the type system theater of "messages" hides that the substrate doesn't believe in them.
3. **Single representation.** Boundary translation maintains two reps (paired substrate + synthesized messages). They drift. The substrate model is one rep end-to-end: reducer holds it, streaming writes it, snapshot exposes it, render iterates it.

**Migration.** Single landing commit. The dependencies between types, reducer state, handlers, streaming paths, data source, consumers, and tests are tight enough that dual-rep migration would carry more risk (drift between reps) than just cutting over. The working tree is green at each step of the cutover; the commit boundary is just where the last `bun x tsc --noEmit && bun test` goes green.

**Wire contract verified against captures.** Two facts pin the design:

1. **The wire is explicitly block-bracketed.** Every content block lives inside a `content_block_start { index, content_block: { type: "text" | "thinking" | "tool_use", ... } }` → N × `content_block_delta { index, delta }` → `content_block_stop { index }` envelope. The block kind is on the start event; the index is monotonic per message and resets at each `message_start`. The append-or-mutate rule keys on wire truth, not a heuristic: a new `(msg_id, block_index)` pair mints a new Message; subsequent deltas with the same `(msg_id, block_index)` append.
2. **Thinking and text are always discrete blocks.** They use different `content_block.type` values and distinct indices; the wire never interleaves them within a single block.

**IPC contract change (tugcode → tugdeck).** Tugcode already parses `content_block_start` / `content_block_delta` internally — it currently collapses them into per-msg_id text streams before forwarding. Step 5 surfaces the block structure:

- New event: `content_block_start { msg_id, block_index, kind: "text" | "thinking" | "tool_use", tool_use_id?, tool_name? }`. Emitted at every wire `content_block_start`. Drives the reducer's Message-mint.
- New event (optional, marker only): `content_block_stop { msg_id, block_index }`. Reducer-tolerant — used for diagnostics; not required for correctness.
- `AssistantTextEvent` / `ThinkingTextEvent` gain `block_index: number`. Reducer correlates each delta with its mint via `(msg_id, block_index)`.
- `tool_use` / `tool_result` / `tool_use_structured` IPC unchanged — `tool_use_id` is already the identity; `tool_use` events update the input on the matching `tool_use` Message in place.

**Multi-msgId-per-turn handling (correctness improvement).** The wire emits multiple `message_start` events per logical turn — a tool-use loop iterates `thinking + tool_use → tool_result → thinking + tool_use → tool_result → text` across multiple distinct `msg_id`s, all bracketed by one `result` event. Today's substrate keys `scratch` by `msg_id`; `buildTurnEntry` reads only `scratch[activeMsgId]` (the final iteration). Earlier iterations' thinking text is in scratch but never read into the committed `TurnEntry` — a silent loss.

Step 5 keys scratch by `turnKey`, not `msg_id`. A turn's `ScratchEntry` accumulates Messages across every iteration, preserving thinking/tool calls/text in arrival order. `msg_id` becomes metadata stored on each Message (carried through the `(msg_id, block_index)` mint key) rather than a substrate primary key. At commit, `messages` contains the full turn — every iteration's contribution faithfully preserved.

**`messageKey` derivation finalizes:**

- User message: `${turnKey}-user` (one per turn at most).
- Wire-derived Messages (text / thinking / tool_use): `${msg_id}-b${block_index}`. Intrinsically unique within a session; debuggable.
- System notes (Step 8's scheduled prompts; future `compact_boundary` notes): `${turnKey}-sys${seq}` where `seq` is monotonic within the turn.

#### [D08] Cohort B trigger correlation via per-session FIFO {#d08-cohort-b-fifo}

**Decision:** Tugcode buffers `ScheduleWakeup` / `CronCreate` tool_use payloads in a per-session FIFO at the time they appear on the stdout wire. On a Cohort B wake bracket:

- `ScheduleWakeup` fire → consume the FIFO's head ScheduleWakeup entry.
- `CronCreate` fire → look up the entry by `cron_id` (the harness's re-init does not carry it, so the lookup is best-effort: most recent CronCreate with no CronDelete). Recurring fires reuse the same entry until a CronDelete arrives.

The FIFO is per-session, in-memory, dropped on session close. Persisted via [D10]'s sidecar for replay.

**Rationale:** The harness's `system/init` re-emit carries no metadata identifying which scheduled task fired. The FIFO is best-effort but reliable in practice — concurrent unrelated scheduled tasks fire at minute boundaries with discrete identities and rarely overlap. The misattribution edge case (two ScheduleWakeup tasks with identical `delaySeconds`) is documented as a non-goal; the chrome chip will display the misattributed prompt, which is visible to the user and recoverable.

#### [D09] Chrome visual class — chip above the assistant row {#d09-chrome-visual-class}

**Decision:** A `<TranscriptChrome>` chip renders above the wake turn's assistant text. The chip is a kind-specific icon + short label:

- `task_notification` → "Monitor" with summary tooltip.
- `schedule_wakeup` → "Scheduled" with fire time + delay tooltip.
- `cron_create` → "Cron" with cron expression + next-fire tooltip.

Click expands an inline detail panel; click again collapses. The chip is the only new chrome element; the assistant text row beneath it is unchanged.

**Rationale:** Minimal disruption to existing transcript layout. Distinct from user-message styling (which the wake lacks). Signals "spontaneous" without consuming a full row. Click-to-expand keeps detail reversible — the chip is glanceable; the panel is on-demand.

#### [D10] Trigger persistence via sidecar JSONL {#d10-sidecar-jsonl}

**Decision:** Tugcode writes wake-trigger metadata to `~/.tugtool/wake-triggers/<session_id>.jsonl`. One line per wake fire:

```json
{ "turn_index": 7, "wake_trigger": { "kind": "schedule_wakeup", "summary": "...", "scheduled_for": "..." }, "prompt": "summarize today's commits" }
```

`turn_index` references the corresponding turn in claude's `~/.claude/projects/<projectId>/<sessionId>.jsonl`. The replay translator loads the sidecar at rehydration time and joins on `turn_index`. Writes are append-only with `fsync` per record.

**Rationale:** Claude's JSONL is owned by Anthropic — we do not modify its schema. A sidecar isolates our metadata; the join key is the only coupling. tugbank's `/api/defaults` model is for user prefs, not per-session timeline metadata; using it here would inflate that namespace inappropriately. The `~/.tugtool/wake-triggers/` directory is tugcode-owned and may be deleted at any time (replay simply omits chrome for affected turns).

#### [D11] Wake prompt carried on `wake_started.wake_trigger.prompt` {#d11-prompt-on-wake-started}

**Decision:** The scheduled prompt extends `wake_started.wake_trigger` with an optional `prompt: string` field. The reducer reads it at bracket-open and appends a `Message { kind: "system_note", text: prompt, source: "scheduled" }` to the wake turn's `messages` array (Step 5 sequence model). Persisted via [D10].

**Rationale:** Avoids a separate `wake_prompt` IPC frame. Keeps all wake metadata in one frame. The field is optional — Cohort A has no synthetic prompt; legacy `wake_started` records without `prompt` remain valid. ipc_version stays at 2 (additive field).

#### [D12] Cancellation transport via hidden user_message {#d12-cancellation-hidden-user-message}

**Decision:** Tide-side cancellation routes through the existing user_message channel:

1. Tugdeck UI sends `cancel_scheduled_task { cron_id }` IPC.
2. Tugcode injects a hidden user_message ("/cancel cron `<id>`") into claude's stdin.
3. Tugcode flags the resulting turn for transcript suppression: no `submit_accepted` is emitted; subsequent `assistant_text` / `turn_complete` frames for that turn are dropped at the tugcode boundary so they never reach the transcript renderer.

**Rationale:** Claude's stream-json `--input-format` accepts only user_message frames as host input — there is no host-initiated tool-call channel. The user_message route is the only supported back-channel for triggering a specific tool (CronDelete). Hiding it from the transcript preserves the affordance's directness: the user clicks Cancel, the chip vanishes, no stray chat turn.

**Known limitation:** claude's brief acknowledgment of the cancellation may leak into the transcript before suppression filters it. Mitigation: prompt-engineer the synthetic message to instruct an empty reply; failing that, accept the brief flash as known polish work.

#### [D13] Replay translator is per-JSONL-entry direct emission {#d13-replay-direct-emission}

**Decision:** The cold-boot JSONL replay translator dispatches each user / assistant JSONL entry to its own IPC events directly, with no cross-entry bookkeeping beyond a single named state field on `TranslateContext`:

```ts
openTurnMsgId: string | null  // tracks the load-bearing msg_id of the currently open turn
```

`openTurnMsgId` tracks *whatever msg_id is currently load-bearing for the open turn* — opener-synthesized when no content has arrived, claude's real `msg_id` once the first content event emits:

| Event the translator emits | `openTurnMsgId` action |
|---|---|
| `add_user_message` (text content user JSONL entry) | Set to synthesized `u-<n>` |
| `wake_started` (`<task-notification>` envelope user entry) | Set to synthesized `w-<n>` |
| First `content_block_start` / `assistant_text` / `thinking_text` / `tool_use` of the open turn (carries claude's real `msg_id`) | **Update to event's real `msg_id`** (overwrites the synthesized opener id) |
| `turn_complete` (assistant entry terminal) | Clear to `null` |
| Entry boundary OR EOF, `openTurnMsgId !== null` | Emit `turn_complete{msg_id: openTurnMsgId, result: "interrupted"}` first, then clear |
| `tool_result` block in user entry | No action |
| Scaffolding (`<command-name>`, etc.) | No action |

A single user JSONL entry carrying multiple text content blocks concatenates them into one `add_user_message.text` per entry. The translator emits one `add_user_message` per user JSONL entry — never more.

**Where the synthesized opener ids appear on the wire.** The synthesized `u-<n>` / `w-<n>` ids are translator-internal in the steady-state path: opener frames (`add_user_message`, `wake_started`) carry no `msg_id` field, so the synthesized id never reaches the wire there. The orphan-synthesis `turn_complete` is the one place a synthesized id reaches the wire — and only in the rare no-content interrupt case (transport loss between the opener and the first content event). Once content has arrived, `openTurnMsgId` holds claude's real `msg_id` and the orphan `turn_complete` carries that. The reducer's `handleTurnComplete` matches on `activeMsgId`, which the first content event also sets to claude's real `msg_id` per [D14] — so the orphan id flows through reducer match without special-casing.

For the no-content interrupt case (`openTurnMsgId` is the synthesized opener id when EOF hits), the reducer's `handleTurnComplete` accepts a `turn_complete` for a `pendingTurn` whose `activeMsgId` is `null` — it commits whatever `pendingTurn` carries (`[user_message]`-only for `u-<n>` openers; `[]` for `w-<n>` openers) and routes through the same interrupted-before-response path the live wire uses.

**Rationale:**
- The current `pendingUserText` / `pendingUserAttachments` / `cycleOpen` / `cycleMsgId` / `flushPendingOrphan` / `pendingWakeFromReplay` apparatus is residue from the paired-substrate's "turn = user + assistant" contract. Under [D07] the substrate is keyed by `turnKey` and accumulates `messages: Message[]` in arrival order; cycle pairing has nothing to track.
- Wake bracket orphans (transport loss mid-wake) get the same treatment as user-side orphans — the tracker doesn't care which kind of opener it's closing. One switch arm replaces three apparatuses.
- Updating `openTurnMsgId` on first content arrival is what makes orphan synthesis correct across all interrupt cases: no-content (synthesized id → reducer's no-`activeMsgId` commit path), with-content (real `msg_id` → reducer's normal-commit path). Without this update rule, the reducer's match would fail on the with-content case — the same paired-substrate-style leak this cluster is built to close.
- The same-`msg_id` peek-ahead for the SDK's "one logical message split across two JSONL records" continuation case is kept (per-entry "is this the terminal for its msg_id?" decision, not cycle pairing).

**Implications:**
- `TranslateContext` carries only `globalSeq`, `turnsCommitted`, `openTurnMsgId`, `orphanCounter`, `telemetry`. No `pending*` opener fields. No `cycleOpen`. No `flushPendingOrphan` function.
- The translator's content-emit sites (`content_block_start`, `assistant_text`, `thinking_text`, `tool_use`) MUST update `openTurnMsgId` if it's still holding the synthesized opener id. Implemented as a single helper `noteContentMsgId(ctx, msg_id)` — idempotent (no-op if `openTurnMsgId === msg_id`); called from every content-emit path.
- The reducer's `handleTurnComplete` (in addition to its existing match-by-`activeMsgId` path) accepts a `turn_complete` for the current `pendingTurn` when `activeMsgId === null` — commits the pendingTurn as an interrupted-before-response turn. Pin in `#spec-reducer-state`.
- The wake-replay regression class (a new wake variant requiring a third mode added to cycle pairing) cannot recur — wake openers and user openers share the same tracker.
- Tests that pinned internal cycle state delete; tests that pin contract behavior stay. New test `replay-interrupted-with-content.test.ts` pins the orphan synthesis for the with-content case (real `msg_id` flows through to commit).

#### [D14] `activeMsgId` is a tracking field, set by first content event {#d14-active-msg-id-tracking}

**Decision:** The reducer's `activeMsgId` is set by the first content event of each turn (`assistant_text` / `thinking_text` / `tool_use` / `content_block_start`), read by `handleTurnComplete` to determine the committing turn and by `handleInterrupt` to distinguish CASE A from CASE B. `handleAddUserMessage` (the replay opener) does NOT pre-bind `activeMsgId`. The LIVE `handleSend` path already does not pre-bind; the replay path now matches.

**Rationale:**
- Pre-binding `activeMsgId` from a synthesized user-side id is residue from the paired-substrate's "user and assistant halves share one `msg_id`" mental model. Under [D07] the substrate's correlation key is `turnKey`; `activeMsgId` tracks claude's *real* msg_id only, surfaced by the first content event.
- Replay and live converge on identical handler behavior — no "replay sets it early, live sets it late" asymmetry.
- Dedupe via `committedMsgIds` keys on claude's real `msg_id` carried by `turn_complete`. Synthesized user-side `u-<n>` and wake-side `w-<n>` ids are translator-internal and never reach `committedMsgIds`.

**Implications:**
- `handleAddUserMessage` body: mint pending turn from the event; do not touch `activeMsgId`. The user-message Message lands in `pendingTurn.initialMessages` per [D07].
- `committedMsgIds`'s doc comment explicitly notes assistant-side-only dedupe so future bug investigations have the right mental model.
- A theoretical replay-overlap bug (two `add_user_message` emits before a `turn_complete`) overwrites the prior `pendingTurn` rather than double-committing a turn. Acceptable.

#### [D15] IPC event name reflects substrate operation; `add_<kind>` template {#d15-add-kind-naming}

**Decision:** IPC events that mint Messages in the substrate are named `add_<kind>` after the Message kind they produce — symmetric with `content_block_start { kind: "text" | "thinking" | "tool_use" }`'s message-kind-keyed naming.

The user-side replay-direction frame becomes `add_user_message` (was `user_message_replay`). The `msg_id` field is removed in the same change (the reducer doesn't read it under [D14]; the translator's `openTurnMsgId` tracker holds the synthesized id internally per [D13]). Final shape: `{ type: "add_user_message", text, attachments, ipc_version }`.

Step 8's system_note replay event becomes `add_system_note`. Any future Message-creating IPC event follows the `add_<kind>` pattern.

The outbound wire frame (tugdeck → tugcode → claude) stays `UserMessage` — it's a *submission* to claude, semantically distinct from "add a Message to the substrate." If a future symmetric rename is desired the outbound becomes `SubmitUserMessage`; out of scope for this phase.

**Rationale:**
- The old `user_message_replay` name was operation-centric, inherited from the paired-substrate's user/assistant-halves model. Under message-forward, name the event after what it *does to the substrate*, not where it came from.
- Symmetric with `content_block_start { kind }`; readers extend the same mental model to both sites.
- Sets the template for Step 8 and beyond.

**Implications:**
- Rename touchpoints: wire frame type, tugcode IPC type (`UserMessageReplay` → `AddUserMessage`), reducer event type (`UserMessageReplayEvent` → `AddUserMessageEvent`), reducer handler (`handleUserMessageReplay` → `handleAddUserMessage`).
- TSC-coordinated: tugcode and tugdeck must rename together. No back-compat carry (single-repo single-developer; rebuild discipline per `feedback_tugcode_compile`).
- Test fixtures with pre-rename JSONL captures stay (they persist claude's own format, not ours).

#### [D16] Tool dispatch flows `ToolUseMessage` only — `msgId` removed {#d16-tool-dispatch-msg-id-removed}

**Decision:** The tool-block render dispatch surface (`dispatchToolCallState`, `ToolBlockProps`, `RenderInput.tool_call`, the `CodeRowBody`'s `toolMsgId` threading) drops the `msgId` parameter entirely. Tool blocks read what they need from the `ToolUseMessage` they receive — `messageKey`, `toolUseId`, `toolName`, `input`, `result`, etc.

**Rationale:**
- `msgId` threading was load-bearing under the paired-substrate's "tool blocks are a flat list correlated by msg_id" model. Under [D07] each `ToolUseMessage` is its own substrate entity with its own `messageKey`; the msg_id is metadata on the Message, not a routing key.
- Reduces the API surface tool-block authors must understand. The Message *is* the unit of identity for the renderer too.
- TSC-enforced cleanup: signature mismatch fails compilation; no silent residue possible.

**Implications:**
- `dispatchToolCallState(toolCall, depth?, ...)` — `msgId` parameter gone.
- `ToolBlockProps.msgId` deleted; consumer audit confirms zero behavior reads it today.
- `RenderInput.tool_call.msgId` removed from the union.
- `tide-card-transcript.tsx` drops the `inflightMsgId` subscription and the `turn.msgId` fallback that fed `toolMsgId`.
- `body-kinds/agent-transcript-block.tsx` drops the recursive `msgId` thread.

#### [D18] Per-Message PropertyStore subscription keyed by `messageKey` {#d18-per-message-property-paths}

**Decision:** Streaming text and tool-state writes go through PropertyStore paths keyed per-Message:

| Channel | Path |
|---|---|
| `assistant_text` / `assistant_thinking` text deltas | `turn.${turnKey}.message.${messageKey}.text` |
| `tool_use` state (input fill / result / structured) | `turn.${turnKey}.message.${messageKey}.state` (JSON-serialized) |

The pre-Step-5 fixed channels (`turn.${turnKey}.assistant` / `.thinking` / `.tools`) retire. The `write-inflight` effect carries `messageKey` and `channel: "text" | "state"`.

**Rationale:**
- Per-Message paths are the substrate-truth analogue of per-Message addressability. Each Message renderable surface (inline inside `CodeRowBody`) subscribes to its own Message's path; subscriptions don't reshuffle when sibling Messages mutate.
- `messageKey` is already stable across in-flight → committed per [D07]; the inline renderer subscribes once and retains its source forever per [L26].
- The code row's body iterates `messages` and dispatches each kind to its inline surface, each surface subscribing to its own Message's path. No multiplexing inside a single surface.

**Implications:**
- The inline `assistant_text` / `assistant_thinking` renderers inside `CodeRowBody` subscribe to `turn.${turnKey}.message.${messageKey}.text`.
- The inline `tool_use` dispatch reads tool state from the Message and from `turn.${turnKey}.message.${messageKey}.state` for streaming updates.
- One subscription per Message renderable. Per-Message paths survive any future "promote-a-Message-to-its-own-row" experiment without a substrate change.

#### [D19] TideZ1B owns committed-end-state; TideZ1C owns in-flight indicator {#d19-z1b-z1c-separation}

**Decision:** Split TideZ1B's pre-Step-5.8 multiplexed responsibility into two distinct components with disjoint domains. Both attach to the assistant row via a `TugTranscriptEntry` slot; both collapse to zero-height when empty.

- **TideZ1B** (committed-end-state aggregate): rendered in `TugTranscriptEntry`'s existing `controls` slot — the row footer. Carries the per-turn end-state badge (OK / interrupted / error / transport_lost), per-turn tokens, per-turn wall-clock, whole-turn COPY. Collapses to zero when no end-state is yet defined (no `min-height` when empty).
- **TideZ1C** (in-flight indicator): rendered in a **new** `inflightFooter` slot on `TugTranscriptEntry`. The in-flight code row passes a `<TideZ1C codeSessionStore={...} />` element to the slot iff `!isCommitted`; every other row passes `null` and the slot stays collapsed. Z1C subscribes to `snapshot.phase` + `snapshot.interruptInFlight` via `useSyncExternalStore` (one memoized selector — no churn on text deltas).

**Z1C content table** (driven by `snapshot.phase` + `snapshot.interruptInFlight`; empty rows mean the slot collapses):

| Phase / state | Indicator |
|---|---|
| `submitting` | TugThinkingIndicator "Submitting…" |
| `awaiting_first_token` | TugThinkingIndicator "Thinking…" |
| `streaming` | TugThinkingIndicator "Streaming…" |
| `tool_work` | TugThinkingIndicator "Tool work…" |
| `waking` | TugThinkingIndicator "Waking…" |
| `awaiting_approval` | (collapsed — we're waiting, not thinking; the pending dialog *is* the affordance) |
| `interruptInFlight === true` | (collapsed — interrupt is instant from the user's POV; Z1B paints the end-state once the turn commits) |
| `idle` / `replaying` / `errored` | (collapsed) |

The visible glyph is whatever `TugThinkingIndicator` paints by default (no label, no caution chrome). The phase label rides on `aria-label` for screen readers; visible content stays the same three-bar glyph the pre-Step-5.8 in-row indicator carried.

**Rationale:**
- Today's TideZ1B multiplexes "indicator ↔ end-state display." The two chromes have semantically distinct domains: Z1B is *what just finished*, Z1C is *what's currently happening*. Splitting them lets each evolve independently.
- Disjoint slots (one for end-state, one for in-flight indicator) means neither has to know about the other's render condition.
- Position is "free": the slot inherits the row body's indent and footer placement; the indicator naturally appears where Z1B's pre-Step-5.8 live branch used to render.
- Hiding Z1C during `awaiting_approval` keeps the pending dialog as the sole affordance — no redundant "Awaiting approval" status alongside the request.
- Hiding Z1C while `interruptInFlight` is true keeps the stop gesture feeling instant from the user's POV; Z1B carries the formal "interrupted" result.

**Implications:**
- `TugTranscriptEntry` gains an opt-in `inflightFooter?: React.ReactNode` slot with a collapse-when-empty CSS rule.
- TideZ1B's CSS loses its `min-height` so the controls slot collapses when no end-state is rendered.
- New component `TideZ1C` (file pair `tide-card-z1c.tsx` + `.css`) with a co-located pure-logic helper `tideZ1CContent(phase, interruptInFlight)` returning `{label} | null`.
- `CodeRowCell` passes `<TideZ1C codeSessionStore={...} />` to `inflightFooter` iff `!isCommitted`; only the in-flight code row holds the subscription. Other rows pass `null` (no subscription, no wake on dispatch).

---

### Specification {#specification}

#### Wire frames {#spec-wire-frames}

**`wake_started`** (tugcode → tugdeck IPC, ipc_version 2):

```ts
interface WakeStarted {
  type: "wake_started";
  session_id: string;
  wake_trigger: {
    // Always present
    task_id: string;          // empty for Cohort B (no tool id on the wire)
    tool_use_id: string;      // empty for Cohort B
    status: "completed" | "failed" | "stopped";
    summary: string;          // user-supplied reason for Cohort A; tool kind label for Cohort B
    output_file: string;

    // Added by Step 6+; optional, ipc_version stays at 2
    kind?: "task_notification" | "schedule_wakeup" | "cron_create";
    prompt?: string;          // [D11] — Cohort B only, the registered scheduled prompt
    scheduled_for?: string;   // ISO timestamp — ScheduleWakeup fire time
    cron_expression?: string; // CronCreate's expression string
    cron_id?: string;         // CronCreate's id (for cancellation routing per [D12])
  };
  ipc_version: 2;
}
```

No `wake_complete` frame. The bracket closes on the next `turn_complete`.

**`cancel_scheduled_task`** (tugdeck → tugcode IPC, added by Step 9):

```ts
interface CancelScheduledTask {
  type: "cancel_scheduled_task";
  session_id: string;
  cron_id: string;
  ipc_version: 2;
}
```

No response frame on the wire — the user sees the chip vanish (state derives from the suppressed CronDelete result; see [D12]).

**`add_user_message`** (tugcode → tugdeck IPC, ipc_version 2; renamed from `user_message_replay` in Step 5.5 per [D15]):

```ts
interface AddUserMessage {
  type: "add_user_message";
  text: string;
  attachments: ReadonlyArray<AtomSegment>;
  ipc_version: 2;
}
```

No `msg_id` field. The reducer doesn't read it ([D14]); the translator's `openTurnMsgId` tracker holds the synthesized opener id internally and never emits it on this frame ([D13]). Content frames (`assistant_text`, `thinking_text`, `tool_use`, `turn_complete`) continue to carry claude's real `msg_id` on the wire — that *is* load-bearing for `(msg_id, block_index)` Message resolution and for assistant-side dedupe.

#### Replay translator state {#spec-translate-context}

`TranslateContext` (cold-boot JSONL → IPC translator state) after [D13]:

```ts
interface TranslateContext {
  globalSeq: number;             // monotonic sequence counter for synthesized ids
  turnsCommitted: number;        // count of turn_complete emits (for diagnostics)
  openTurnMsgId: string | null;  // [D13] — single opener tracker; replaces all paired cycle state
  orphanCounter: number;         // count of EOF / boundary orphan syntheses (for diagnostics)
  telemetry: TranslatorTelemetry;
}
```

**State rules (locked under [D13]):**

| Event | `openTurnMsgId` action |
|---|---|
| Emit `add_user_message` (user JSONL entry, text content) | Set to synthesized `u-<n>` |
| Emit `wake_started` (`<task-notification>` envelope user entry) | Set to synthesized `w-<n>` |
| Emit first `content_block_start` / `assistant_text` / `thinking_text` / `tool_use` of open turn (carries claude's real `msg_id`) | **Update to event's real `msg_id`** (overwrites the synthesized opener id) |
| Emit `turn_complete` (assistant entry terminal) | Clear to `null` |
| Entry boundary OR EOF, `openTurnMsgId !== null` | Emit `turn_complete{msg_id: openTurnMsgId, result: "interrupted"}` first, then clear |
| `tool_result` block in user entry | No action (mid-turn, not an opener) |
| Scaffolding (`<command-name>`, etc.) | No action |

The content-arrival update is implemented as a single helper `noteContentMsgId(ctx, msg_id)` — idempotent (no-op if `openTurnMsgId === msg_id`); called from every content-emit path.

`openTurnMsgId`'s synthesized ids are translator-internal in the steady-state path: opener frames (`add_user_message`, `wake_started`) carry no `msg_id` field, so the synthesized id never reaches the wire there. The synthesized id reaches the wire ONLY via the orphan-synthesis `turn_complete` AND only in the no-content interrupt case (transport loss between opener and first content event). Once content has arrived, `openTurnMsgId` holds claude's real `msg_id` and the orphan `turn_complete` carries that — matching the reducer's `activeMsgId` (which the first content event sets to the same value per [D14]).

#### Reducer state {#spec-reducer-state}

`CodeSessionState` gains (Slice 1 — shipped):

```ts
phase: ... | "waking";
wakeTrigger: WakeTrigger | null;  // camelCase, populated on wake_started, cleared on turn_complete
```

`CodeSessionSnapshot` mirrors the same.

Slice 1c-b ([D07], Step 5) replaces the paired substrate with a full sequence substrate. See [D07] for the full type definitions; the surface relevant to the snapshot is:

```ts
interface TurnEntry {
  turnKey: string;
  msgId: string;
  messages: ReadonlyArray<Message>;
  // turn-level metadata unchanged: result, endedAt, wallClockMs,
  // awaitingApprovalMs, transportDowntimeMs, activeMs, ttftMs,
  // ttftcMs, reconnectCount, maxStreamGapMs, turnEndReason, cost
}

interface ActiveTurnSnapshot {
  turnKey: string;
  submitAt: number;
  isWake: boolean;
  messages: ReadonlyArray<Message>;     // live, mutates as wire events land
}

interface CodeSessionSnapshot {
  // ... unchanged surface ...
  transcript: ReadonlyArray<TurnEntry>;
  activeTurn: ActiveTurnSnapshot | null;   // replaces inflightUserMessage
}
```

Removed from `TurnEntry`: `userMessage`, `thinking`, `assistant`, `toolCalls`. Removed from snapshot: `inflightUserMessage`. Removed from reducer state: `toolCallMap` (folded into `ScratchEntry.toolCallIndex` per [D07]), `pendingUserMessage` (replaced by `pendingTurn`).

**`handleTurnComplete` match rules (under [D13] / [D14]).** The reducer matches an incoming `turn_complete{msg_id}` event to a committing turn via two paths:

1. **Normal path (content arrived):** `event.msg_id === state.activeMsgId` → commit `state.scratch[turnKey]` where `turnKey` comes from `state.pendingTurn.turnKey`. The activeMsgId may equal claude's real `msg_id` (live wire or replay-with-content) or the translator's synthesized opener id (replay-no-content; see path 2).
2. **No-content interrupt fallback (translator orphan synthesis with synthesized opener id):** `state.activeMsgId === null && state.pendingTurn !== null` → commit `state.pendingTurn` as an interrupted-before-response turn. Whatever `pendingTurn.initialMessages` carries (`[user_message]` for u-<n> openers; `[]` for w-<n> openers) becomes the committed turn's `messages`. The event's `msg_id` is logged but otherwise unused — the synthesized opener id never enters `committedMsgIds`.
3. **No match → drop.** No `pendingTurn` AND no matching `activeMsgId` → log and drop. Defensive; should not occur in well-formed wire / JSONL.

Path 2 is what makes [D13]'s no-content orphan-synthesis correct: the translator emits `turn_complete{msg_id: synthesized}`, the reducer accepts based on `pendingTurn` presence rather than msg_id match, and the substrate commits cleanly.

#### Phase transitions {#spec-phase-transitions}

```
LIVE / live-with-replay-resumed:
  idle ───wake_started──→ waking ───turn_complete──→ idle (commits wake TurnEntry)
                            │
                            └──interrupt──→ committing → idle (commits partial or cancels)

REPLAY (cold-boot JSONL → IPC translator):
  replaying ───wake_started──→ replaying ───turn_complete──→ replaying (commits wake TurnEntry; stays in replaying)
  replaying ───add_user_message──→ replaying ───…content…──→ replaying ───turn_complete──→ replaying
  replaying ───EOF / replay_complete──→ idle
```

`handleWakeStarted` accepts from BOTH `idle` and `replaying` phases. The phase transition rule:

```ts
const nextPhase: CodeSessionPhase =
  state.phase === "replaying" ? "replaying" : "waking";
```

During replay, `wake_started` does NOT transition phase to `waking` — `replaying` is preserved so the replay bracket's `replay_complete` cleanly returns to `idle`. Live `wake_started` from `idle` transitions to `waking` as before.

`submit` from `waking` enters the same merge-with-active-wake path as submit during streaming. The `Send` button is disabled during `waking`; `Stop` is enabled.

#### Guard loosening (only one needed) {#spec-guard-loosenings}

`handleTextDelta`'s phase guard: `if (state.phase !== "idle" && state.phase !== "streaming" && state.phase !== "waking") return ...`. Every other guard stays as drop case.

#### Transcript rendering {#spec-transcript}

**Slice 1c-b (Step 5) — substrate-only render scope per [D07].** The data source's row contract is unchanged from Slice 1c-a: one `user` row per turn that contains a `user_message` Message + one `code` row per turn + ghost rows for queued sends. The data source's row-shape decisions are now driven by message presence instead of by the empty-text sentinel:

- Emit a `user` row iff `turn.messages` (or `activeTurn.messages`) contains a `user_message` Message at its first position. Wake turns naturally don't (their `messages` opens with `assistant_text`), so no user row.
- Emit a `code` row per turn (committed or in-flight). The code row's renderer iterates `messages` and dispatches each Message kind to its inline renderer (`assistant_text` → text area; `assistant_thinking` → `TideThinkingBlock`; `tool_use` → `TideCardTranscriptToolCalls`; `system_note` → added in Step 8).

The `TideTranscriptCellKind` enum stays at `user | code | ghost`. The code row's internal renderer is what handles per-Message dispatch.

Wake-turn chrome (Step 6): if `turn.wakeTrigger != null` (committed) or `activeTurn.isWake && activeTurn.messages.length > 0` (inflight), the chrome chip renders above the code row's content (inside the code row, not as a separate list row).

Ghost rows for queued sends unchanged: one per `QueuedSend`, key `${turnKey}-ghost`.

**No `isWakeTurn` / `isWakeInflight` predicates.** The "does this turn have a user_message Message?" check is inline and trivial (`turn.messages[0]?.kind === "user_message"`); no named helper needed.

**No `userRowIndexForTurn`'s `-1` sentinel.** `userRowIndexForTurn(turnIndex, transcript)` either returns a valid index when the turn has a user_message Message, or the function isn't called for wake turns (callers gate on `turn.messages[0]?.kind === "user_message"`).

**Per-Message PropertyStore paths.** Subscribers read per-Message streaming paths (`turn.${turnKey}.message.${messageKey}.text` for text/thinking Messages; `turn.${turnKey}.message.${messageKey}.state` for tool_use Messages). The code row's inline renderers iterate `messages` and dispatch each Message kind to its own renderable surface, each subscribing to its own Message's path. [L26] holds per-Message: each Message's renderer reference is stable; the renderable surface is keyed by `messageKey` and stable across in-flight → committed.

#### TideZ1C — in-flight indicator zone {#spec-z1c}

`TideZ1C` (added by Step 5.8 per [D19]) is the in-flight indicator chrome for the assistant row. It attaches to the row via a new `inflightFooter` slot on `TugTranscriptEntry` — every `TugTranscriptEntry` instance carries the slot uniformly, and the slot collapses to zero-height when no content is passed.

Contract:
- The in-flight code row (`!isCommitted`) passes `<TideZ1C codeSessionStore={...} />` to `inflightFooter`; every other row passes `null` and the slot collapses.
- Z1C subscribes via `useSyncExternalStore` to a memoized `{phase, interruptInFlight}` selector — one subscription, no churn on text deltas.
- Indicator content is resolved by `tideZ1CContent(phase, interruptInFlight)` per [D19]'s table; when it returns `null` the slot stays collapsed and the row paints nothing.
- Position is inherited from the row body's indent and footer placement (no absolute positioning, no manual offset math) — visually identical to the position TideZ1B's pre-Step-5.8 live branch occupied.

TideZ1B's pre-Step-5.8 in-flight branch (`participant === "code"` + no `turn`) is removed; TideZ1B becomes purely the committed-end-state renderer in the `controls` slot and itself collapses to zero-height when no end-state is yet defined (no `min-height` when empty), so the two slots never conflict for vertical space.

---

### Compatibility / Migration / Rollout {#rollout}

No migration required. The change is additive:

- New IPC frame `wake_started` (consumers that don't know about it ignore it).
- New reducer phase `waking` (a value, not a schema change).
- New `wakeTrigger` snapshot field (nullable; legacy consumers see `null`).

Rollback is trivial: revert the commits. No persisted state shape changes.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

**Slice 1 (shipped):**

- `tugcode/src/__tests__/wake-reinit.test.ts` — re-init detector tests.
- `tugcode/probes/wake-investigation/probe-harness.mjs` — spawns claude directly, captures the raw stream-json wire.
- `tugcode/probes/wake-investigation/probe-tugcode.mjs` — spawns the compiled tugcode binary, captures its IPC stdout end-to-end.
- `tugcode/probes/wake-investigation/analyze.mjs` — decodes a capture for human reading.
- `tugcode/probes/wake-investigation/capture-{sw-60,cron-1m}-*.{stdout,jsonl,meta,stderr}` — committed capture artifacts.
- `dash/archive/wake-investigation-findings.md` — empirical findings doc anchoring [D05].

**Slice 1c-b + Slice 2 (in flight):**

- `tugcode/src/wake-trigger-sidecar.ts` — write/read primitive for `~/.tugtool/wake-triggers/<session_id>.jsonl` (Step 7).
- `tugcode/src/__tests__/wake-trigger-sidecar.test.ts` — sidecar write + concurrent-read invariants.
- `tugcode/src/__tests__/wake-trigger-correlation.test.ts` — Cohort B FIFO drain semantics (Step 6).
- `tugcode/src/__tests__/cancellation.test.ts` — `cancel_scheduled_task` → hidden user_message → suppression invariants (Step 9).
- `tugdeck/src/components/tugways/transcript/transcript-chrome.tsx` — chip renderer (Step 6); context menu added in Step 9.
- `tugdeck/src/components/tugways/transcript/system-note-row.tsx` — subdued row for `system_note` Messages (Step 8).

#### Symbols added / modified {#symbols}

**Slice 1 (shipped):**

`tugcode/src/session.ts`:

- `class SessionManager` gains `private sessionInitSeen: boolean = false` (reset by `killAndCleanup`).
- `handleClaudeLine` gains the re-init detector branch ([D05]).
- New private method `handleWakeReInit()` — Cohort B bracket-open (mirrors `handleTaskNotification`).
- `handleTaskNotification` (Cohort A) is unchanged.
- New IPC type `WakeStarted` and pure helper `buildWakeStartedMessage`.

`tugdeck/src/lib/code-session-store/`:

- `reducer.ts` gains `handleWakeStarted`, `wakeTrigger` state field, `waking` phase value.
- `types.ts` gains `WakeStartedEvent`, `WakeTrigger`.
- `frameToEvent.ts` mints a `turnKey` for the wake bracket.

`tugdeck/src/lib/tide-transcript-data-source.ts`:

- Per-snapshot offset-table lookup replaces flat-index math.
- `isWakeTurn` / `isWakeInflight` helpers.
- `userRowIndexForTurn` returns `-1` for wake turns (consumers handle the sentinel).

**Slice 1c-b + Slice 2 (in flight):**

`tugcode/src/session.ts` (Step 5 IPC extension):

- `mapStreamEvent`'s `content_block_start` branch emits a new `content_block_start` IPC frame (`msg_id`, `block_index`, `kind`, optional `tool_use_id` / `tool_name`).
- `assistant_text` / `thinking_text` emissions gain `block_index` from the wire's `content_block_delta.index`.
- Optional: `content_block_stop` emission for diagnostics.

`tugcode/src/ipc.ts` (Step 5):

- `ContentBlockStart` IPC frame type.
- `AssistantText` / `ThinkingText` gain `block_index: number`.

`tugcode/src/__tests__/wake-sdk-drift.test.ts` (Step 5):

- Existing fields pinned plus `block_index` and the new `content_block_start` events.

`tugdeck/src/lib/code-session-store/types.ts`:

- `MessageKind`, `Message` discriminated union ([D07], Step 5).
- `TurnEntry` reshaped to `{ turnKey, msgId, messages, ...turn-level metadata }`; `userMessage` / `thinking` / `assistant` / `toolCalls` fields deleted (Step 5).
- `ActiveTurnSnapshot` interface; `CodeSessionSnapshot.activeTurn` replaces `inflightUserMessage` (Step 5).
- `ToolCallState` interface deleted — fields move onto `ToolUseMessage` (Step 5).
- `WakeTrigger` extended with `kind`, `prompt`, `scheduled_for`, `cron_expression`, `cron_id` (Step 6).
- `CancelScheduledTaskFrame` outbound IPC type (Step 9).

`tugdeck/src/lib/code-session-store/events.ts`:

- `ContentBlockStartEvent` (new): `{ type: "content_block_start", msg_id, block_index, kind, tool_use_id?, tool_name? }` (Step 5).
- `ContentBlockStopEvent` (new, optional): `{ type: "content_block_stop", msg_id, block_index }` (Step 5).
- `AssistantTextEvent` / `ThinkingTextEvent` gain `block_index: number` (Step 5).

`tugdeck/src/lib/code-session-store/reducer.ts`:

- `state.scratch` re-keys from `Map<msgId, {assistant, thinking}>` to `Map<turnKey, ScratchEntry>` (Step 5; correctness improvement — preserves all msgId iterations).
- `state.pendingTurn` replaces `state.pendingUserMessage` (Step 5).
- `state.toolCallMap` deleted; tool index folded into `ScratchEntry.toolCallIndex` (Step 5).
- New `handleContentBlockStart` mints a Message of the given kind, indexes by `(msg_id, block_index)` (Step 5).
- `handleTextDelta` rewrites to look up the open Message via `(msg_id, block_index)` and mutate text (Step 5).
- `handleToolUse` / `handleToolResult` / `handleToolUseStructured` mutate Messages via `toolCallIndex` (Step 5).
- `handleSend` / `handleWakeStarted` seed `pendingTurn.initialMessages` (Step 5; Step 8 extends `handleWakeStarted` to include the `SystemNote` for `wakeTrigger.prompt`).
- `buildTurnEntry` simplifies to `messages: Array.from(scratch[turnKey]?.messages ?? [])` plus turn-level metadata (Step 5).
- `write-inflight` effect kind carries `messageKey` and `channel: "text" | "state"` (Step 5).

`tugdeck/src/lib/code-session-store/store.ts`:

- Snapshot derivation builds `activeTurn` from `pendingTurn` + scratch (Step 5).
- `cancelScheduledTask(cron_id)` action (Step 9).

`tugdeck/src/lib/tide-transcript-data-source.ts`:

- Substrate-only scope per [D07]: row contract preserved (user + code + ghost). Decisions driven by message presence instead of empty-text sentinel (Step 5).
- `isWakeTurn` / `isWakeInflight` predicates deleted; checks inlined via `turn.messages[0]?.kind === "user_message"` (Step 5).
- `userRowIndexForTurn`'s `-1` sentinel branch deleted; callers gate the call instead (Step 5).
- `assistantRowIndexForTurn` simplified (one code row per turn; no wake-row special case) (Step 5).
- `RowLayout` / `buildRowLayout` / `locateCommittedRow` simplify (the variable-rows-per-turn machinery added in Slice 1c-a retires; rows-per-turn is `(has_user_message ? 1 : 0) + 1` — the user row is conditional, the code row is always present) (Step 5).
- `TideTranscriptCellKind` unchanged: `"user" | "code" | "ghost"` (Step 5; Step 6 chrome renders inside the code row; per-Message rows are a future deliberate UX step).
- Wake chrome inlined into the code row by the code-row renderer (Step 6); not a new row kind.

`tugdeck/src/components/tugways/cards/tide-card-transcript.tsx`:

- Cell renderers updated: each Message kind maps to one renderer; per-Message streaming subscriptions key off `messageKey` (Step 5).

`tugdeck/src/components/tugways/cards/turn-entry-markdown.ts`:

- Iterates `turn.messages` filtering `assistant_text` (was: read `turn.assistant`) (Step 5).

`tugdeck/src/components/tugways/cards/tide-card-telemetry-popovers.tsx`:

- Reads the first `user_message` Message's text (was: `turn.userMessage.text.trim()`) (Step 5).

`tugdeck/src/components/tugways/chrome/tide-thinking-block.tsx`:

- Reads `assistant_thinking` Message(s) (was: `TurnEntry.thinking`) (Step 5).

`tugcode/src/session.ts`:

- `pendingWakeTriggers` per-session FIFO ([D08], Step 6).
- `wake_started` emission extended with new optional fields (Step 6).
- Sidecar JSONL write on every wake bracket ([D10], Step 7).
- `handleCancelScheduledTask` IPC handler — injects hidden user_message ([D12], Step 9).
- Turn-suppression flag and IPC-frame filter for the hidden cancellation turn (Step 9).

---

### Test Plan Concepts {#test-plan-concepts}

Pure-logic only (no DOM). Three layers:

1. **Reducer**: each handler tested with hand-built `WakeStartedEvent` / `TurnCompleteEvent` against the state shape.
2. **tugcode dispatcher**: `handleClaudeLine` / `handleInterTurnEvent` / `handleWakeReInit` tested with parsed JSON event objects; assert state transitions and IPC emissions.
3. **Wire shape pinning**: drift tests load captured stream-json fixtures and assert the fields tugcode reads are present.

---

### Execution Steps {#execution-steps}

The implementation shipped across the following work; all steps are complete except Step 4.

#### Step 1: Slice 1 — Cohort A wake bracket {#step-1}

**Status:** Shipped.

**Scope:** `wake_started` IPC + reducer `waking` phase + `handleTaskNotification` detector for `system/task_notification`.

**Files:**
- `tugcode/src/session.ts`: `buildWakeStartedMessage`, `handleTaskNotification`, `WakeStarted` type.
- `tugdeck/src/lib/code-session-store/reducer.ts`: `handleWakeStarted`, `wakeTrigger` state, `waking` phase.
- `tugdeck/src/lib/code-session-store/frameToEvent.ts`: `turnKey` mint for the wake bracket.
- `tugdeck/src/lib/code-session-store/types.ts`: `WakeStartedEvent`, `WakeTrigger`.
- Drift test: `tugcode/src/__tests__/wake-sdk-drift.test.ts`.

**Manual repro:** Monitor / Bash runbg / Task runbg (idle wait) — wake turn paints.

#### Step 2: Slice 1b — Cohort B re-init detector {#step-2}

**Status:** Shipped (final fix in commit `bcc3e2b6`).

**Scope:** `handleWakeReInit` for the harness fire signal (`system/init` between turns).

**Files:**
- `tugcode/src/session.ts`: `sessionInitSeen` field, re-init detector branch in `handleClaudeLine`, `handleWakeReInit` method.
- `tugcode/src/__tests__/wake-reinit.test.ts` (6 cases).

**Manual repro:** ScheduleWakeup 60s / CronCreate one-shot / CronCreate recurring + CronDelete — all paint correctly (verified in sessions 95d18839, 017f1206, 5f5af4de; Monitor regression in 2cad794c).

#### Step 3: Slice 1c-a — transcript single-row for wake turns {#step-3}

**Status:** Shipped (commit `19c8cb58`).

**Scope:** `TideTranscriptDataSource` per-snapshot offset table; `isWakeTurn` / `isWakeInflight` helpers; `userRowIndexForTurn` returns `-1` for wake turns.

**Files:**
- `tugdeck/src/lib/tide-transcript-data-source.ts`
- `tugdeck/src/lib/__tests__/tide-transcript-data-source.test.ts` (8 new wake-row cases).
- `tugdeck/src/components/tugways/cards/tide-card-telemetry-popovers.tsx` (one consumer updated for `-1` sentinel).

**Manual repro:** wake fires without phantom "You" bubble.

#### Step 4: Robustness — wire-shape drift test + resume-mode verification {#step-4}

**Status:** Drift test shipped (10 cases). Resume-mode probe shipped; **empirical finding: scheduled wakes do not fire after resume in stream-json spawn mode** — an upstream Claude Code limitation, NOT a tugcode bug. Documented in `dash/archive/wake-investigation-findings.md`.

**Artifacts:**

1. **Drift test for the Cohort B re-init pattern (SHIPPED).** `tugcode/src/__tests__/wake-reinit-drift.test.ts` loads `tugcode/probes/wake-investigation/capture-sw-60-*.stdout` and `capture-cron-1m-*.stdout` and asserts five invariants per capture:
   - exactly two `system/init` events (spawn + wake fire),
   - the first turn closes with `result/success` before the wake fires,
   - the second `system/init` is followed by the wake's `message_start`,
   - no `system/task_notification` precedes the wake (rules out Cohort A misclassification),
   - the wake turn closes with its own `result/success`.

   A future Claude Code release that changes any of these invariants fails the test loudly with a fixture-diff message instead of silently breaking Cohort B in production.

2. **Resume-mode probe (SHIPPED, finding documented).** `tugcode/probes/wake-investigation/probe-resume.mjs` spawns tugcode in new mode, schedules a ScheduleWakeup, kills tugcode, respawns in `--session-mode resume`, holds 150s past the scheduled fire time, and reports a PASS / FAIL verdict.

   **Empirical result: FAIL.** In `--input-format stream-json --output-format stream-json --resume <id>` mode, claude restores the scheduled task's metadata (it can describe what's pending when asked) but the in-process scheduler does NOT actually fire restored tasks. No `system/init` re-emit, no synthetic user_message, no assistant turn — the wake simply never lands. The official scheduled-tasks docs claim `--resume` restores unexpired tasks; that does not appear to hold in our spawn configuration. Documented in detail in [`archive/wake-investigation-findings.md`](./archive/wake-investigation-findings.md).

   **Why this is not a tugcode bug:** the detector handles the fire signal correctly; the fire just doesn't arrive. If a future Claude Code release restarts the scheduler in this mode, the probe will PASS without tugcode code changes.

   **User-visible implication:** if a Tide session is closed before a scheduled wake fires and the user then reopens the session via the resume path, the wake will NOT fire. Sessions that stay open continuously are unaffected (Probes 1-4 confirmed live).

**Checkpoint:**
- `cd tugcode && bun x tsc --noEmit && bun test` green (463 tests).
- Resume-mode probe `bun probe-resume.mjs` runs end-to-end; current VERDICT line is `FAIL` for the reason above. If/when upstream changes, the same probe will surface a `PASS`.

**Resolution / scope decision (2026-05-25):** in-session reliability is the gating success criterion; cross-restart wake delivery is not. The resume-mode failure is corroborated by the broader pattern of scheduled-task reliability bugs filed against Claude Code (see [#40228](https://github.com/anthropics/claude-code/issues/40228) durable flag, [#44128](https://github.com/anthropics/claude-code/issues/44128) tasks don't fire when desktop closed, [#36131](https://github.com/anthropics/claude-code/issues/36131) tasks need active focus, [#56194](https://github.com/anthropics/claude-code/issues/56194) feature request for app-independent scheduling). All four of those issues are open and unaddressed upstream; our case fits the same pattern. The findings doc is moved to [`archive/`](./archive/wake-investigation-findings.md) to keep the active plan focused on shipped capability. Slice 1 closes; the resume-mode failure stands as a known upstream limitation that the existing detector will pick up automatically if/when Anthropic ships a fix.

#### Step 5: Slice 1c-b — full sequence substrate {#step-5}

**Status:** Shipped. Commit 1 (tugcode IPC extension) and Commit 2 (tugdeck substrate refactor) both landed on main; `cd tugdeck && bun x tsc --noEmit && bun test` green (2795 tests pass, 0 fail).

**Scope:** Lift the turn model to a sequence substrate end-to-end per [D07]. Reducer state, streaming PropertyStore paths, snapshot, data source, and every consumer model a turn as an ordered sequence of typed Messages. Message is the unit of identity, mutation, streaming subscription, and rendering. Paired-field aggregation and parallel `toolCallMap` storage retire. The [D06] wake sentinel is removed at every site.

This is **not** a boundary-translation refactor. The substrate believes in the sequence; consumers don't have to maintain a fiction.

**Architectural decisions locked in [D07]:**

- Message union: `user_message | assistant_text | assistant_thinking | system_note | tool_use`.
- `messageKey` derivation: wire-derived Messages use `${msg_id}-b${block_index}` (intrinsically unique, matches wire structure); user_message uses `${turnKey}-user`; system_notes use `${turnKey}-sys${seq}`.
- `TideTranscriptCellKind` unchanged for Step 5: `user | code | ghost`. Substrate gains the sequence model; row layout preserved. See "Render-surface scope" below.
- `ToolCallState` retires onto `ToolUseMessage`. Consumer code reads tool calls via `messages.filter(kind === "tool_use")` or via a helper (`getToolUseMessages(turn)`).
- `state.pendingUserMessage` and `snapshot.inflightUserMessage` replaced by `state.pendingTurn` and `snapshot.activeTurn`.
- `state.scratch` re-keys from `Map<msgId, ...>` to `Map<turnKey, ...>`. One scratch entry per turn; spans every msgId iteration of the turn's tool-use loop.
- IPC contract extends: tugcode emits new `content_block_start` (and optional `content_block_stop`) events; existing `AssistantTextEvent` / `ThinkingTextEvent` gain `block_index`.

**Render-surface scope (substrate-only).** Step 5 changes the data substrate, not the visible transcript layout. The data source emits rows for `user_message | ghost` only. Other Message kinds exist in `turn.messages` and `activeTurn.messages` but render via the existing inline surfaces inside the code row:

- `assistant_text` Messages: their content drives the code row's text area. The code row subscribes to per-Message streaming paths and joins them at render time. When a turn has multiple `assistant_text` Messages (multi-block / multi-iteration), they render in sequence within the code row with the interleaved tool calls between them — same visual as today's "text + tools + text" layout, just driven by Message sequence instead of paired fields.
- `assistant_thinking` Messages: rendered via existing `TideThinkingBlock` inside the code row. Content comes from `assistant_thinking` Messages instead of `TurnEntry.thinking`.
- `tool_use` Messages: rendered via existing `TideCardTranscriptToolCalls` inside the code row. Component accepts `ReadonlyArray<ToolUseMessage>` (renamed from `ReadonlyArray<ToolCallState>`; same field shape).
- `system_note` Messages: zero instances exist until Step 8; renderer added then.

This preserves today's transcript visual exactly. The substrate gains the sequence model and the correctness wins (preserved interleaving + multi-msgId concatenation); the row layout is unchanged. A future deliberate UX step ("per-Message row layout") can promote selected Message kinds to top-level rows when that visual change is intentional and worth its own design and review.

**Wire contract — verified against captures (`tugcode/probes/wake-investigation/capture-*.stdout`):**

1. Content blocks are explicitly bracketed (`content_block_start` / `content_block_stop`); index is monotonic per message; kind is on the start event.
2. Thinking and text are always discrete blocks (different `content_block.type`, never interleaved within a block).
3. A logical turn spans multiple `message_start` events (one per tool-use loop iteration). Today's substrate keys scratch by `msg_id` and only reads the final iteration's content at commit — silently dropping intermediate iterations' thinking text. Step 5 fixes this by keying scratch by `turnKey`.

See [D07] for the full wire-truth-driven append rule.

**Files (production — tugcode side):**

- `tugcode/src/session.ts` — `mapStreamEvent`'s `content_block_start` branch emits a new `content_block_start` IPC frame (with `msg_id`, `block_index`, `kind`, optional `tool_use_id` / `tool_name`); existing `assistant_text` / `thinking_text` emissions gain `block_index`. Optional `content_block_stop` emission for diagnostics. Tugcode-side text/thinking flow no longer needs to track "is this a continuation of an earlier block" since the boundary is now explicit on the wire to tugdeck.
- `tugcode/src/session.ts` — `emitInflightTurnFromActiveTurn` (mid-turn replay snapshot emitter): rewritten under the per-Message snapshot pattern from [D07]. See [D07] § Mid-turn replay snapshot for the decision.
- `tugcode/src/replay.ts` — cold-boot JSONL → IPC translator. Updated to emit `content_block_start` for each text/thinking/tool_use block per replayed message, and to carry `block_index` on the resulting `assistant_text` / `thinking_text` emissions. Per-turn output ordering gains the block-start preludes; the reducer's `replaying` phase still commits one `TurnEntry` per `turn_complete`, now with `messages` populated correctly across all msgIds of the turn.
- `tugcode/src/ipc.ts` (or wherever IPC frame types live) — new `ContentBlockStart` type; `AssistantText` / `ThinkingText` types gain `block_index`.
- `tugcode/src/__tests__/*` — drift tests + mapStreamEvent unit tests updated. `tugcode/src/__tests__/wake-sdk-drift.test.ts` (existing) extends to assert block-index forwarding. New: `tugcode/src/__tests__/replay-block-emissions.test.ts` pins replay translator's per-message block emissions against a representative JSONL fixture (and against a multi-msgId tool-use-loop fixture — the multi-iteration case that today's substrate dropped intermediate thinking from).

**Files (production — tugdeck side):**

- `tugdeck/src/lib/code-session-store/types.ts` — Message union, ScratchEntry (turnKey-keyed), PendingTurn, ActiveTurnSnapshot, TurnEntry reshape. `ToolCallState` deleted; `inflightUserMessage` deleted; `userMessage` / `thinking` / `assistant` / `toolCalls` deleted from TurnEntry.
- `tugdeck/src/lib/code-session-store/events.ts` — new `ContentBlockStartEvent` (and optional `ContentBlockStopEvent`); `AssistantTextEvent` / `ThinkingTextEvent` gain `block_index: number`.
- `tugdeck/src/lib/code-session-store/effects.ts` — `write-inflight` effect kind carries `messageKey` and `channel: "text" | "state"`.
- `tugdeck/src/lib/code-session-store/reducer.ts` — substrate change (see [D07] handler-by-handler table). Bulk of the work. New `handleContentBlockStart` handler. `scratch` re-keys to `turnKey`.
- `tugdeck/src/lib/code-session-store/code-session-store.ts` (or wherever the snapshot builder lives) — derive `activeTurn` from `pendingTurn` + scratch.
- `tugdeck/src/lib/tide-transcript-data-source.ts` — under Step 5's substrate-only render scope, the data source iterates `turn.messages` looking only for `user_message` Messages to emit user rows; the code row is still one row per turn. Delete `isWakeTurn` / `isWakeInflight` / `userRowIndexForTurn`'s `-1` sentinel branch; replace the offset table with a simpler "does the turn's messages array contain a user_message?" check. (A future per-Message-row step replaces this fully.)
- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` — the code row's data feed becomes per-Message: subscribes to each `assistant_text` Message's `text` path and joins them in sequence. The current `turn.${turnKey}.assistant` subscription retires.
- `tugdeck/src/components/tugways/cards/tide-card-transcript-tool-calls.tsx` — accepts `ReadonlyArray<ToolUseMessage>` in place of `ReadonlyArray<ToolCallState>` (same field shape; type alias retired; callers extract from `turn.messages.filter(kind === "tool_use")` or via a helper). Internal logic unchanged.
- `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts` — `dispatchToolCallState(toolCall, msgId)` accepts `ToolUseMessage` (renamed from `ToolCallState`); function name kept as `dispatchToolCallState` for grep-stability, OR renamed to `dispatchToolUseMessage` — implementer's call. Internal logic unchanged; the new type's added fields (`messageKey`, `createdAt`, `kind`) are unused by the renderer but harmless.
- `tugdeck/src/components/tugways/cards/turn-entry-markdown.ts` — replaces `turn.assistant.trim()` with iteration over `turn.messages` filtering `assistant_text` and joining with the markdown-block separator. Tool calls accessed via the same filter pattern for `tool_use` Messages (existing `parentToolUseId` nesting logic unchanged; the field is on `ToolUseMessage`).
- `tugdeck/src/components/tugways/cards/tide-card-telemetry-popovers.tsx` — replaces `turn.userMessage.text.trim()` with reading the `user_message` Message: `turn.messages.find(m => m.kind === "user_message")?.text.trim() ?? ""`.
- `tugdeck/src/components/tugways/chrome/tide-thinking-block.tsx` — accepts `text` prop unchanged; caller derives the text from `assistant_thinking` Messages (concatenated if multiple) instead of `TurnEntry.thinking`. Component internals unchanged.
- Galleries (`gallery-tool-block-default.tsx`, `gallery-task-inline-tool-block.tsx`): fixture files; their `ToolCallState` references become `ToolUseMessage`. Mechanical.

**Files (tests — net coverage preserved, shape updated):**

- `tugdeck/src/lib/code-session-store/__tests__/*` — ~30 reducer tests. Most diffs are mechanical: `expect(state.scratch.get(msgId)?.assistant).toBe(...)` → `expect(findMessageByKind(state.scratch.get(turnKey)!, "assistant_text")?.text).toBe(...)`. Build a small test helper module (`__tests__/_helpers/messages.ts`) for "find Message of kind", "construct fixture TurnEntry with messages", "build event sequence for a multi-msgId turn", etc.
- `tugdeck/src/lib/__tests__/tide-transcript-data-source.test.ts` — updated to assert the substrate-aware row layout: 1 row per wake turn (no `user_message` head), 2 rows per normal turn (user + code), +1 ghost per queued send. The code row's body iterates `messages` and dispatches each kind to its inline renderer.
- `tugdeck/src/__tests__/session-wake-fixture-replay.test.ts` — fixture-replay test. The captured fixtures don't change; the assertions about shape do.
- `tugdeck/src/__tests__/assistant-rendering-fixture-replay.test.ts` — same.
- `tugdeck/src/components/tugways/cards/__tests__/tide-card-transcript-tool-calls.test.ts` — tool-call rendering test; shape updates.

**New tests added under Step 5 (the regression net for substrate correctness):**

- `tugdeck/src/lib/code-session-store/__tests__/reducer.message-sequence.test.ts` — pins three invariants against synthesized event sequences:
  1. **Block boundary correctness:** `content_block_start{idx:0,kind:text}` → text deltas → `content_block_start{idx:1,kind:tool_use}` → input_json deltas produces a `messages` array of `[AssistantText, ToolUseMessage]` in that order.
  2. **Multi-msgId concatenation:** events for two `msg_id`s within one turn (`message_start A → text → tool_use → tool_result → message_start B → text → result`) commit a single `TurnEntry` whose `messages` array spans BOTH msgIds.
  3. **Interleaved thinking:** `thinking(block 0)` + `text(block 1)` in one message commit as two distinct Messages in arrival order — neither merged nor reordered.
- `tugdeck/src/lib/code-session-store/__tests__/reducer.message-key-stability.test.ts` — pins that `messageKey` is byte-identical across in-flight → committed transition for every Message kind (the per-Message analogue of today's `turnKey` stability test).
- `tugcode/src/__tests__/map-stream-event-block-index.test.ts` (Commit 1) — pins that `mapStreamEvent` emits `content_block_start` with correct `block_index` and forwards `block_index` on every text/thinking delta. Loads `capture-sw-60-*.stdout` and `capture-cron-1m-*.stdout` as fixtures; asserts the emission count + ordering.
- `tugcode/src/__tests__/inflight-turn-snapshot.test.ts` (Commit 1) — pins that `emitInflightTurnFromActiveTurn` emits the per-Message replay stream correctly per [D07] § Mid-turn replay snapshot: for an active turn with assistant_text + tool_use + tool_result + assistant_text, the snapshot emits `content_block_start` + terminal frame for each, in arrival order, inside the `replay_started` / `replay_complete` bracket.
- `tugdeck/src/lib/code-session-store/__tests__/reducer.snapshot-idempotence.test.ts` (Commit 2) — pins that `handleContentBlockStart` is a no-op for `(msg_id, block_index)` pairs already present in `scratch[turnKey].blockIndex`. Covers the live-then-snapshot race: live `content_block_start` mints, then a `replay_started` bracket re-emits the same `content_block_start` — second emission must not duplicate-mint.

**Commit sequence — two commits, tugcode then tugdeck:**

The tugcode IPC extension is additive (new event type, new field on existing events) and can land first without breaking tugdeck — the new events flow through ignored by the old reducer; the new `block_index` field is a no-op for the old handlers. The tugdeck refactor then lands as a single substrate change.

**Commit 1 — tugcode IPC extension:**
1. Add `ContentBlockStart` IPC frame type; extend `AssistantText` / `ThinkingText` with `block_index`.
2. Update `mapStreamEvent`: emit `content_block_start` at every wire `content_block_start`; forward `block_index` on every text/thinking delta.
3. Update mapStreamEvent unit tests + drift tests to assert the new emissions.
4. Rebuild tugcode binary (`bun build --compile`); verify tugcode still produces today's IPC stream plus the new events.
5. `cd tugcode && bun x tsc --noEmit && bun test` green.
6. Commit on main.

**Commit 2 — tugdeck substrate refactor:**
1. Draft `types.ts` changes; tsc reveals the consumer-error set.
2. Add `ContentBlockStartEvent` to events.ts (+ `block_index` on existing text events).
3. Rewrite reducer state shape + handlers; add `handleContentBlockStart`. Reducer tests fail in expected places only.
4. Rewrite snapshot builder (`activeTurn` derivation).
5. Rewrite data source.
6. Rewrite consumers (5 files).
7. Update all failing tests in one pass.
8. `cd tugdeck && bun x tsc --noEmit && bun test` green.
9. Manual repro of the matrix below.
10. Commit on main.

The two-commit shape makes each commit independently revertable: tugcode change can roll back without affecting tugdeck (new events become unused emissions); tugdeck change can roll back without affecting tugcode (the new IPC events flow back into the void).

If commit 2 ends up too large to review comfortably, split by file at commit time using `git add -p` — but the working tree is always green at the commit boundary.

**Manual repro:**

- A normal user → assistant turn renders two rows (user_message + assistant_text).
- A turn where claude says text, calls a tool, then says more text commits as three rows in order — distinct from today's "all text squashed into one row above the tool log."
- A turn with interleaved thinking renders the thinking block in its arrival position relative to assistant text.
- A wake turn renders one row (assistant_text only; no empty-text sentinel anywhere).
- Replay of a recorded session produces identical row output to pre-Step-5 for simple turns; multi-block / interleaved turns now render with preserved ordering.
- `grep -rE "isWakeTurn|isWakeInflight|userRowIndexForTurn|assistantRowIndexForTurn|inflightUserMessage|\\.toolCallMap|\\bpendingUserMessage\\b" tugdeck/src` returns nothing (or only deletion-marker comments awaiting a follow-up cleanup commit).
- `grep -rE "TurnEntry\\.userMessage|TurnEntry\\.assistant\\b|TurnEntry\\.thinking|TurnEntry\\.toolCalls" tugdeck/src` returns nothing.

**Pre-flight checklist (before starting Commit 1):**

1. Verify today's tugdeck reducer default-drops unknown event types safely (the dispatch switch's default branch must not throw or corrupt state). If it throws, harden it first as a zero-impact prep commit so Commit 1's new `content_block_start` events flow through harmlessly when received by an old tugdeck.
2. Confirm `bun build --compile` produces the right tugcode binary in `tugrust/target/debug/tugcode` (and the Tug.app sibling location). Sanity check by running today's tugcode against today's tugdeck end-to-end after a rebuild — establish baseline before any change.
3. Re-read `mapStreamEvent` end-to-end to confirm there are no other sites where block_index is silently dropped beyond the two I've identified (`content_block_start` for tool_use, `content_block_delta` for text/thinking).
4. Verify the test capture fixtures (`capture-sw-60-*`, `capture-cron-1m-*`) are sufficient for the multi-msgId test. They show tool-use loops; if a more complex multi-iteration trace is needed (e.g., multiple tool calls per loop), capture a fresh probe.

**Definition of Done — Commit 1 (tugcode IPC extension):**

- New `ContentBlockStart` IPC frame type; `AssistantText` / `ThinkingText` carry `block_index`.
- `mapStreamEvent` emits one `content_block_start` per wire `content_block_start`; every text/thinking delta carries `block_index`.
- New unit test `map-stream-event-block-index.test.ts` passes against captured fixtures.
- Existing tugcode drift tests + unit tests pass.
- `cd tugcode && bun x tsc --noEmit && bun test` green.
- Tugcode binary rebuilt; manual sweep confirms today's tugdeck still works against the new tugcode (new events ignored by old reducer; old events still work).
- Commit on main.

**Definition of Done — Commit 2 (tugdeck substrate refactor):**

- `TurnEntry` reshape (`messages: ReadonlyArray<Message>`); paired fields deleted.
- Reducer substrate (turnKey-keyed scratch, `pendingTurn`, `handleContentBlockStart`, append-or-mutate rule).
- Snapshot exposes `activeTurn` (replaces `inflightUserMessage`).
- Data source iterates messages; offset table + sentinel helpers deleted.
- 5 consumer files updated.
- All reducer + data source + replay + card tests pass.
- New tests pass: `reducer.message-sequence.test.ts`, `reducer.message-key-stability.test.ts`.
- `cd tugdeck && bun x tsc --noEmit && bun test` green.
- Manual sweep against the matrix below.
- Commit on main.

**Checkpoint (post Commit 2 manual sweep):**

- Send a normal user turn → user row + code row render correctly.
- Send a turn that triggers a tool call mid-stream → tool row appears in arrival position (NOT below all text).
- Send a turn that triggers a multi-iteration tool loop → every iteration's thinking + tool_use + final text preserved in the transcript (correctness improvement over today).
- Trigger a wake (Cohort A: Monitor; Cohort B: ScheduleWakeup or Cron) → wake turn renders single-row with no phantom user bubble.
- Reopen a session via session-history → replayed turns render with the same shape as live.
- Grep checks: `grep -rE "isWakeTurn|isWakeInflight|userRowIndexForTurn|assistantRowIndexForTurn|inflightUserMessage|\\.toolCallMap" tugdeck/src` returns nothing.

**Backwards compatibility during transition window:**

After Commit 1 lands and before Commit 2 lands, tugcode emits new events that tugdeck's old reducer doesn't know about. The reducer's default-drop behavior (verified in pre-flight #1) ensures these are inert — no state corruption, no thrown errors. Existing functionality is preserved end-to-end. The transition window can be any length; we choose it (no concurrent contributors).

After Commit 2 lands, tugdeck strictly requires the new IPC fields. Running an old tugcode binary against new tugdeck would surface a fatal dev-log entry on every text event (missing `block_index`). The fix is to rebuild tugcode — `bun build --compile` produces the binary that both Tug.app and the standalone tugcode use. No silent failure mode.

#### Step 5.5: IPC rename — `user_message_replay` → `add_user_message` {#step-5-5}

**Depends on:** #step-5

**Commit:** `ipc(tide-wake-5/5): rename user_message_replay → add_user_message; drop msg_id`

**References:** [D14] activeMsgId tracking, [D15] add_<kind> naming, (#spec-wire-frames, #spec-translate-context)

**Status:** Shipped. All tasks complete; both TSC + test suites green; tugcode binary rebuilt; zero residual references to the old names in production code.

**Why this step exists.** Step 5 shifted the *substrate* to a Message sequence per [D07] but did not audit the emitters and consumers for residue of the OLD substrate's mental model. The user-side IPC frame still carries the operation-centric name `user_message_replay` and an `msg_id` field the reducer does not read. This step renames the frame per [D15] and drops the field — the smallest coordinated wire-shape change of the cluster, landed first because it unblocks every downstream step's naming.

**Artifacts:**

- Wire frame type `"add_user_message"` (was `"user_message_replay"`); `msg_id` field removed.
- IPC type `AddUserMessage` (was `UserMessageReplay`).
- Reducer event type `AddUserMessageEvent` (was `UserMessageReplayEvent`).
- Reducer handler `handleAddUserMessage` (was `handleUserMessageReplay`); stops pre-binding `activeMsgId` per [D14].
- Reducer `handleTurnComplete` gains the no-content fallback rule per `#spec-reducer-state` rule 2: `state.activeMsgId === null && state.pendingTurn !== null` → commit `pendingTurn` as an interrupted-before-response turn. Required in lockstep with the pre-bind removal so the no-content interrupt replay case doesn't regress in the window between Steps 5.5 and 5.6.
- `handleWakeStarted` phase rule pinned per `#spec-phase-transitions`: accepts from `idle | replaying`; `nextPhase` is `"replaying"` when coming from `replaying`, else `"waking"` (already in main; this step pins it in the plan).
- `committedMsgIds` doc comment updated to document assistant-side-only dedupe per [D14].

**Tasks:**

- [x] `tugcode/src/types.ts`: rename `UserMessageReplay` → `AddUserMessage`; delete `msg_id` field. The IPC frame `type` becomes `"add_user_message"`.
- [x] `tugcode/src/replay.ts`: all emit sites and type references update to `add_user_message` / `AddUserMessage`. Translator internals stay; [D13]'s direct-emission rewrite is Step 5.6.
- [x] `tugdeck/src/lib/code-session-store/events.ts`: rename `UserMessageReplayEvent` → `AddUserMessageEvent`; delete `msg_id`; event `type` becomes `"add_user_message"`.
- [x] `tugdeck/src/lib/code-session-store/reducer.ts`:
  - rename `handleUserMessageReplay` → `handleAddUserMessage`
  - rename `case "user_message_replay":` arm to `case "add_user_message":`
  - remove the `activeMsgId = event.msg_id` pre-bind line per [D14]
  - add the no-content fallback to `handleTurnComplete` per `#spec-reducer-state` rule 2 (commits `pendingTurn` when `activeMsgId === null`)
  - update `committedMsgIds` doc comment per [D14] (assistant-side-only dedupe)
- [x] Update test fixtures: any captured-IPC fixture containing the literal `"user_message_replay"` string must be regenerated or hand-updated. (Note: claude's own JSONL format never used this name — `user_message_replay` was always our IPC frame name. There is no "preserve claude's format" exemption.)
- [x] Audit test files for any literal `"user_message_replay"` strings or `UserMessageReplayEvent` type references; update in lockstep.
- [x] Rebuild tugcode binary (`bun build --compile`).

**Tests:**

- [x] Existing reducer tests pass with new event name. (2800 tests green in tugdeck.)
- [x] Existing replay tests pass with new wire-frame type string. (462 tests green in tugcode.)
- [x] New reducer test: `handleTurnComplete` with `activeMsgId === null` and `pendingTurn !== null` commits `pendingTurn` (no-content fallback). One case for `pendingTurn.initialMessages === [user_message]` (user-side interrupt); one for `[]` (wake-side interrupt with no assistant content). (Plus a third pinning that the synthesized opener id enters `committedMsgIds` for dedupe, a fourth pinning the stray-event drop, and a fifth as a regression guard for the live happy path.) See `tugdeck/src/lib/code-session-store/__tests__/reducer.no-content-fallback.test.ts`.

**Checkpoint:**

- [x] `cd tugcode && bun x tsc --noEmit && bun test` green.
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` green.
- [x] `grep -rnE "user_message_replay|UserMessageReplay|handleUserMessageReplay" tugcode/src tugdeck/src --include="*.ts"` returns zero matches.
- [x] Manual sweep: replay a recorded session; user messages paint as user rows; no regression.

---

#### Step 5.6: Replay translator per-entry direct emission {#step-5-6}

**Depends on:** #step-5-5

**Commit:** `tugcode(tide-wake-5/6): replay translator per-entry direct emission`

**References:** [D13] replay direct emission, [D14] activeMsgId tracking, (#spec-translate-context)

**Status:** Shipped. Cycle apparatus retired in tugcode/src/replay.ts (TranslateContext now `globalSeq` / `turnsCommitted` / `openTurnMsgId` / `orphanCounter` / `telemetry` only). Per-entry direct emission, with `noteContentMsgId` helper flipping synthesized opener ids to claude's real msg_id on first content arrival. EOF orphan synthesis unified into `emitOrphanIfOpen`. Three new test files (14 tests total) pin the new contract. Both TSC + test suites green; tugcode binary rebuilt.

**Why this step exists.** Under the paired substrate's "turn = `user_message_replay` opener + N assistant frames + `turn_complete`, all sharing one `msg_id`" contract, the replay translator carried a cycle-pairing apparatus (`pendingUserText` / `pendingUserAttachments` / `cycleOpen` / `cycleMsgId` / `flushPendingOrphan` / `pendingWakeFromReplay`). Under [D07] the substrate is keyed by `turnKey` and accumulates `messages: Message[]` in arrival order; cycle pairing is no longer load-bearing and actively obstructs new opener kinds. The wake-replay regression was the first symptom — fixed by patching cycle pairing rather than retiring it. This step retires it per [D13].

**Artifacts:**

- `tugcode/src/replay.ts` rewritten per [D13]: `TranslateContext` carries only `globalSeq`, `turnsCommitted`, `openTurnMsgId`, `orphanCounter`, `telemetry`. No `pending*` opener fields. No `cycleOpen`. No `flushPendingOrphan`.
- Per-entry handlers: `handleUserEntry` dispatches each user JSONL entry to its own IPC events with no cross-entry buffering; `handleAssistantEntry` emits per-block `content_block_start` + terminal frames with one same-`msg_id` peek-ahead for the SDK continuation case.
- EOF / entry-boundary orphan synthesis: if `openTurnMsgId !== null`, emit `turn_complete{msg_id: openTurnMsgId, result: "interrupted"}` before the next opener.
- Multi-text-block user entries concatenate into one `add_user_message` per entry per [D13].

**Tasks:**

- [x] Delete from `TranslateContext`: `pendingUserText`, `pendingUserAttachments`, `cycleOpen`, `cycleMsgId`, `pendingWakeFromReplay`.
- [x] Add `openTurnMsgId: string | null` to `TranslateContext`.
- [x] Delete `flushPendingOrphan`.
- [x] Add `noteContentMsgId(ctx, msg_id)` helper per [D13]: idempotent (no-op if `openTurnMsgId === msg_id`); otherwise sets `openTurnMsgId = msg_id`. Called from every content-emit path so synthesized opener ids flip to claude's real `msg_id` on first content arrival.
- [x] Rewrite `handleUserEntry` for per-content-block dispatch:
  - `<task-notification>` envelope → emit `wake_started{wake_trigger}` (via existing `extractTaskNotificationWake`). Set `openTurnMsgId` to a synthesized `w-<n>`.
  - text content (one or more blocks, concatenated per [D13]) → emit `add_user_message{text, attachments}`. Set `openTurnMsgId` to a synthesized `u-<n>`.
  - `tool_result` blocks → emit `tool_result` per block (does NOT touch `openTurnMsgId`).
  - Scaffolding (`<command-name>` etc.) → skip.
- [x] Rewrite `handleAssistantEntry`: emit per-block `content_block_start` + terminal frames; **at every emit site that carries `msg_id` (content_block_start, assistant_text, thinking_text, tool_use), call `noteContentMsgId(ctx, msg_id)`**; keep the same-`msg_id` peek-ahead for SDK continuation; on terminal `turn_complete` emit, clear `openTurnMsgId`. ALSO: prepend a synthesized empty `add_user_message` when `openTurnMsgId === null` so an assistant entry with no preceding opener (the `--continue` and post-`/compact` cases) has a `pendingTurn` for the reducer to commit onto.
- [x] Add translator-level orphan synthesis at the start of every entry AND at EOF — unified into `emitOrphanIfOpen(ctx)` called from `handleUserEntry` (before any new opener emit) and from `translateJsonlSession`'s EOF block (when `synthesizeDanglingTerminal === true`). Replaces the two old EOF paths (dangling-cycle synth + trailing-orphan flush).
- [x] Rebuild tugcode binary.

**Tests:**

- [x] New: `tugcode/src/__tests__/replay-wake-bracket.test.ts` — contract invariants for the wake's replay path (4 tests):
  - JSONL with a `<task-notification>` envelope user entry → translator emits `wake_started`, NOT `add_user_message`.
  - Wake bracket ordering (`wake_started` before content frames).
  - Mixed session: user-text turn + wake turn each get the right opener kind.
  - Defensive: malformed envelope still emits `wake_started` (best-effort fields).
- [x] New: `tugcode/src/__tests__/replay-interrupted-with-content.test.ts` — pins the orphan-synthesis path with content arrival (the `noteContentMsgId` rule, 5 tests):
  - User opener + partial assistant content + EOF → orphan `turn_complete` carries claude's real `msg_id` (not the synthesized `u-N`).
  - Wake opener + partial assistant content + EOF → same: orphan keyed on real id, not `w-N`.
  - Mid-session interrupt (new opener mid-turn) → first turn's orphan keyed on real id; second turn's orphan (EOF, no content) keyed on `u-N`.
  - Thinking-only content also fires `noteContentMsgId` (the swap rule isn't text-specific).
  - Multi-block content: `noteContentMsgId` is idempotent (no extra mutations beyond the first swap).
- [x] New: `tugcode/src/__tests__/replay-interrupted-no-content.test.ts` — pins the orphan synthesis with NO content (5 tests):
  - User opener only + EOF → orphan `turn_complete` carries synthesized `u-N` id.
  - Wake opener only + EOF → orphan `turn_complete` carries synthesized `w-N` id.
  - User-then-user (no assistant between) → each gets its own no-content orphan with `u-N` ids.
  - User opener with attachments only + EOF → orphan synth fires, attachments preserved on opener.
  - Clean turn + trailing no-content user → first commits with real id, second orphans with `u-N`.
- [x] Audit + update: `tugcode/src/__tests__/replay-eof-orphan.test.ts`, `replay-interrupted-orphan.test.ts`, `replay-string-content.test.ts`, `replay-hmr-mid-stream.test.ts`, `replay.test.ts`. Synthetic-id prefix updated from `orphan-` to `u-` / `w-`; tests pinning internal cycle state (`pendingUserText`, `cycleOpen`) rewrote to assert the new contract (per-entry direct emission, openTurnMsgId tracking).
- [x] Tighten `tugdeck/src/__tests__/session-wake-fixture-replay.test.ts` Scenario 2 with the wake discriminator pin: `expect(entry.messages[0]?.kind !== "user_message").toBe(true)`. Updated to feed `wake_started` (the new translator's emission) instead of the prior `add_user_message`-for-envelope shape.
- [x] Reducer test for the no-content fallback in `handleTurnComplete`: already landed in Step 5.5 (see `reducer.no-content-fallback.test.ts`).

**Checkpoint:**

- [x] `cd tugcode && bun x tsc --noEmit && bun test` green. (476 tests pass, was 462 + 14 new from the three new files.)
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` green. (2800 tests pass.)
- [x] `grep -rE "pendingUserText|pendingUserAttachments|cycleOpen|cycleMsgId|flushPendingOrphan|pendingWakeFromReplay" tugcode/src` returns zero hits in production code (the only remaining matches are explanatory comments naming what was retired — in the [D13] retrospective on `TranslateContext` and in two test-file header comments documenting the pre-fix bug each test was originally written to guard).
- [x] Manual sweep:
  - Cold-boot replay of a wake-containing JSONL paints the wake turn identical to the live path (Monitor tool call + assistant text, no phantom user row).
  - Replay of an interrupted JSONL with partial assistant content (e.g., session killed mid-stream) commits a TurnEntry with the partial content visible — no "lost turn." Confirmed against session 0ff8b401, which carries the with-content interrupt shape on turn 3 (user "output a markdown table…" → assistant `stop_reason: null` with partial markdown → `[Request interrupted by user]` marker → next user submission); the partial markdown table commits cleanly via the `noteContentMsgId` rule (orphan `turn_complete` carries claude's real `msg_01UFe…` id, reducer matches normally).

---

#### Step 5.7: Tool-dispatch `msgId` cleanup {#step-5-7}

**Depends on:** #step-5

**Commit:** `tugdeck(tide-wake-5/7): drop msgId from tool dispatch surface`

**References:** [D16] tool dispatch msgId removed

**Status:** Shipped. `msgId` dropped from `ToolBlockProps`, `RenderInput.tool_call`, and `dispatchToolCallState`'s positional surface. CodeRowBody's `toolMsgId` thread + the `useSyncExternalStore(activeMsgId)` subscription it fed retired. `AgentTranscriptBlock` / `TaskToolBlock` recursive thread retired. Gallery fixtures and test callsites updated. Both TSC + test suites green; tugdeck 2800 pass, tugcode 476 pass; grep audit returns zero.

**Why this step exists.** `msgId` threading on the tool-block dispatch surface (`dispatchToolCallState`, `ToolBlockProps`, `RenderInput.tool_call`, `CodeRowBody`'s `toolMsgId`) was load-bearing under the paired-substrate's "tool blocks are a flat list correlated by msg_id" model. Under [D07] each `ToolUseMessage` carries its own `messageKey`; the msg_id is metadata on the Message, not a routing key. This step retires the dead surface per [D16].

**Artifacts:**

- `dispatchToolCallState(toolCall, depth?, ...)`: `msgId` parameter gone.
- `ToolBlockProps.msgId`: deleted.
- `RenderInput.tool_call.msgId`: removed from the union.
- `CodeRowBody`: no longer threads `toolMsgId`; the `inflightMsgId` subscription and the `turn.msgId` fallback that fed `toolMsgId` are removed.
- `body-kinds/agent-transcript-block.tsx`: recursive `msgId` thread dropped.

**Tasks:**

- [x] `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts`: drop `msgId` parameter from `dispatchToolCallState`; remove from `baseProps` construction; remove from `RenderInput.tool_call`.
- [x] `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx`: drop `toolMsgId` from `CodeRowBodyProps`; remove the `inflightMsgId` subscription; remove the `turn.msgId` fallback.
- [x] `tugdeck/src/components/tugways/body-kinds/agent-transcript-block.tsx`: drop `msgId` from recursive dispatch (also dropped from `AgentTranscriptBlockProps` and `AgentEntryViewProps` — the prop was passthrough-only).
- [x] Audit every tool-block consumer of `ToolBlockProps`; confirm zero behavioral reads of `msgId`. Remove the prop from each consumer's type and TSX. (Audit findings: `TaskToolBlock` destructured `msgId` only to thread back into nested `AgentTranscriptBlock` — pure passthrough, no behavioral read; 11 gallery files carried `msgId` literals as type-satisfying fixtures with no behavioral use; consumer-fallback rule was unneeded.)

**Consumer-fallback rule (if any tool-block needs `msg_id` for behavior).** The audit should find zero such cases. If one surfaces, choose between two recoveries, in this preference order:

1. **Refactor to use `messageKey` instead.** Under [D07] the Message is the identity; `msg_id` is metadata. Most "I need msg_id" reads turn out to be "I need a stable per-tool identifier" — which `messageKey` (and `toolUseId`) already satisfy. Prefer this.
2. **Extract `msg_id` from `messageKey`.** Wire-derived Messages key as `${msg_id}-b${block_index}` per [D07]; recover via `messageKey.split('-b')[0]`. Use only when the consumer genuinely needs claude's `msg_id` (e.g., for cross-referencing claude's JSONL by msg_id). Out of scope for any current consumer.

User-message and system-note messageKeys don't carry an msg_id (no claude-side `msg_id` for those kinds); a consumer that needs msg_id from those Messages is misdesigned and the fix is option 1.

**Tests:**

- [x] Existing tool-block tests pass (signature change is TSC-enforced; behavior unchanged). Test fixtures updated: `tide-assistant-renderer-dispatch.test.ts` (8 tool_call RenderInput literals + 1 `expect(props.msgId).toBe(...)` → `expect(props.msgId).toBeUndefined()`), `default-tool-block.test.ts` (2 dispatchToolCallState calls), `task-tool-block.test.ts` (2 calls), `assistant-rendering-fixture-replay.test.ts` (2 calls), `tide-permission-dialog.tsx`'s `PendingDispatchBody` synthetic dispatch.

**Checkpoint:**

- [x] `cd tugdeck && bun x tsc --noEmit && bun test` green. (2800 tests pass, no regressions.)
- [x] `grep -rE "toolMsgId|ToolBlockProps\.msgId|RenderInput.*msgId\b" tugdeck/src --include="*.tsx" --include="*.ts"` returns zero matches.
- [x] Manual sweep: tool blocks render and update correctly across live, replay, and in-flight → committed transitions; no behavior regression.

---

#### Step 5.8: TideZ1C — per-row in-flight indicator zone {#step-5-8}

**Depends on:** #step-5

**Commit:** `tugdeck(tide-wake-5/8): TideZ1C per-row in-flight indicator zone`

**References:** [D19] Z1B/Z1C separation, (#spec-z1c)

**Status:** Shipped. TideZ1B is purely committed-end-state and the new `inflightFooter` slot on `TugTranscriptEntry` carries the in-flight indicator.

**Why this step exists.** Today's TideZ1B multiplexes "indicator ↔ end-state display." Under per-Message rows the multiplex would conflate two distinct domains. [D19] separates them: TideZ1B owns committed-end-state in the `controls` slot; TideZ1C owns the in-flight indicator in a **new** `inflightFooter` slot on `TugTranscriptEntry`. Every row carries the slot uniformly (collapsed by default); only the in-flight-tip row mounts an active Z1C that subscribes to phase and paints the indicator. Position is inherited from the row body's indent — visually flush with the location TideZ1B's old live branch occupied.

A prior revision of this step tried "transcript-level chrome below `TugListView`" — the indicator ended up marooned at the bottom of the transcript pane instead of at the in-flight row's footer. The per-row-slot approach (a new `inflightFooter` on `TugTranscriptEntry`) dissolves the positioning issue: the slot inherits indentation for free and the in-flight code row mounts the indicator naturally.

**Artifacts:**

- New optional `inflightFooter?: React.ReactNode` slot on `TugTranscriptEntry`, with collapse-when-empty CSS (no `min-height` when the slot is absent / `null`).
- New file pair: `tide-card-z1c.tsx` (the `TideZ1C` component) + `tide-card-z1c.css` (layout for the rendered indicator). Pure-logic helper `tideZ1CContent(phase, interruptInFlight)` in `tide-card-z1c.ts` (sibling) — returns `{label} | null` per [D19]'s table.
- `TideZ1B` loses its in-flight branch (`participant === "code"` + no `turn`). Becomes purely the committed-end-state renderer. Its CSS drops the `min-height` rule so the `controls` slot collapses when no end-state is rendered.
- `CodeRowCell` passes `<TideZ1C codeSessionStore={...} />` to `inflightFooter` iff `!isCommitted`; passes `null` (slot collapsed) when committed. `UserRowCell` / `GhostRowCell` pass nothing — the slot stays collapsed.

**Tasks:**

- [x] Add `inflightFooter?: React.ReactNode` slot to `TugTranscriptEntry`. Sandwiched between the body and the `controls` slot. Wrapper rendered iff prop is non-null + non-undefined; `:empty` CSS rule collapses the wrapper margin when the inner React render produces no DOM children.
- [x] Remove `min-height` from `TideZ1B` so the `controls` slot collapses to zero when Z1B renders no end-state. `CodeRowCell` further gates `controls` to `undefined` when the in-flight code row has no trailing chrome, so the wrapper is not rendered at all.
- [x] Create `TideZ1C` component (`tide-card-z1c.tsx` + `.css`). The component subscribes to a memoized `{phase, interruptInFlight}` selector via `useSyncExternalStore`. Pure-logic helper `tideZ1CContent` co-located in the same `.tsx` file (a sibling `.ts` would have collided on the extension-less import path).
- [x] Implement `tideZ1CContent(phase, interruptInFlight)` per [D19]'s table. Returns `null` for `awaiting_approval`, `interruptInFlight === true`, and `idle` / `replaying` / `errored`.
- [x] The Z1C component renders the bare three-bar `TugThinkingIndicator` (default styling, `labelPosition="hidden"`). Phase label rides on `aria-label`; visible glyph stays identical to the pre-Step-5.8 in-row indicator.
- [x] In `CodeRowCell`, pass `<TideZ1C codeSessionStore={...} />` to `inflightFooter` iff `!isCommitted`. The active subscription mounts only on the in-flight code row.
- [x] Z1C inherits position from the `inflightFooter` slot (the slot's flex / margin own row-level layout); the `tide-card-z1c.css` file is a paired-CSS hook for future indicator-specific tweaks and contains no positioning rules.

**Tests:**

- [x] New: `tideZ1CContent` content-by-phase pin — each phase maps to the expected label per [D19]. `awaiting_approval`, `interruptInFlight=true`, `idle`, `replaying`, `errored` all return `null`.
- [ ] ~~New: `TugTranscriptEntry` `inflightFooter` slot pin~~. Skipped — per the project's no-fake-DOM testing policy there is no render-test surface; the slot's structural contract (render iff non-null; `:empty` collapse) is covered by the manual sweep.
- [x] Existing TideZ1B tests update — in-flight branch tests delete; committed-end-state tests stay. (No-op: TideZ1B carries no pre-existing tests; doc + CSS in-flight references and the `data-mode` selectors / `--tugx-tide-z1b-indent-live` knob were removed.)

**Checkpoint:**

- [x] `cd tugdeck && bun x tsc --noEmit && bun test` green.
- [x] `grep -nE "participant === \"code\".*!turn|!turn.*participant === \"code\"" tugdeck/src/components/tugways/cards/tide-card-z1b.tsx` returns zero matches.
- [x] Manual sweep:
  - Submit a turn; the three-bar indicator appears at the bottom-left of the in-flight code row's body (same indent as the body), animates while phase advances.
  - Turn completes; Z1C slot collapses; Z1B renders end-state on the committed code row at the same position.
  - Open a permission dialog (`awaiting_approval`); the indicator hides — the dialog is the sole affordance.
  - Interrupt mid-stream; the indicator hides immediately (interrupt feels instant); Z1B paints "interrupted" once the turn commits.
  - Trigger a wake (Monitor / ScheduleWakeup); indicator shows the "Waking…" pulse (label not visible, just the bars) then advances through phases.

---

#### Step 6: Slice 2 — trigger-aware chrome (resolves [Q02]) {#step-6}

**Depends on:** #step-5-8

**Commit:** `tide-wake(6): trigger-aware chrome chip above wake turns`

**References:** [D08] Cohort B FIFO correlation, [D09] chip-class chrome, [Q02] trigger chrome (resolves)

**Status:** Not started.

**Scope:** Render a chip above each wake turn identifying its trigger kind per [D09]. Cohort A reads existing `wakeTrigger.summary` / `task_id`. Cohort B reads new fields populated via the per-session FIFO per [D08]. The chip is visual; the detail panel is on-demand (click to expand).

**Artifacts:**

- `tugcode/src/session.ts` — `pendingWakeTriggers` FIFO populated at `ScheduleWakeup` / `CronCreate` tool_use observation time; drained by `handleWakeReInit`. Recurring crons reuse the FIFO entry keyed by `cron_id` until `CronDelete` evicts it.
- `tugdeck/src/lib/code-session-store/types.ts` — `WakeTrigger` extended with `kind`, `prompt?`, `scheduled_for?`, `cron_expression?`, `cron_id?`.
- `tugdeck/src/lib/code-session-store/reducer.ts` — propagate extended fields onto `TurnEntry.wakeTrigger` at `handleWakeStarted`.
- `tugdeck/src/components/tugways/transcript/transcript-chrome.tsx` (new) — chip renderer with click-to-expand detail panel per [D09].
- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` — render chrome chip above the wake turn's first assistant-side row.
- `tugdeck/src/lib/tide-transcript-data-source.ts` — emit `{ kind: "chrome", trigger }` row before the first message row of any wake turn.

**Tasks:**

- [ ] Implement FIFO in `tugcode/src/session.ts`; drain on `handleWakeReInit`.
- [ ] Extend `WakeTrigger` type; thread through reducer at `handleWakeStarted`.
- [ ] Implement `transcript-chrome.tsx` chip renderer + detail panel.
- [ ] Add chrome row to data source emission upstream of the wake turn's first row.
- [ ] Rebuild tugcode binary.

**Tests:**

- [ ] `tugcode/src/__tests__/wake-trigger-correlation.test.ts` — FIFO drain semantics; recurring-cron payload reuse; CronDelete eviction; misattribution edge case per [D08].
- [ ] Data-source test for chrome row emission before the wake turn's first message row.

**Checkpoint:**

- [ ] `cd tugcode && bun x tsc --noEmit && bun test` green.
- [ ] `cd tugdeck && bun x tsc --noEmit && bun test` green.
- [ ] Rebuild tugcode binary.
- [ ] Manual repro:
  - ScheduleWakeup 60s → wake turn paints with a "Scheduled" chip; click expands to show fire time and delay.
  - CronCreate `*/2 * * * *` → each fire paints with a "Cron" chip showing the expression.
  - Monitor 5s → wake turn paints with a "Monitor" chip showing summary.
  - Two ScheduleWakeup tasks registered in quick succession → first fire's chip shows the first prompt, second fire's chip shows the second (FIFO order).

---

#### Step 7: Slice 2 — replay-translator metadata persistence {#step-7}

**Depends on:** #step-6

**Commit:** `tide-wake(7): wake-trigger sidecar JSONL for replay rehydration`

**References:** [D10] sidecar JSONL persistence, [D08] FIFO correlation

**Status:** Deferred. Sidecar files are an anti-pattern we don't want to take on for this — they introduce file-lifecycle and atomicity problems whose maintenance cost dwarfs the value of cold-boot wake-bracket rehydration. The primary consumer of rehydrated wake metadata is the in-process resume path, which is itself blocked upstream by Step 4's known limitation. Reconsider after Step 4's upstream resolves AND a non-sidecar persistence approach has been designed — possibly piggy-backing on claude's own JSONL extension points if/when they emerge.

**Scope:** Cold-boot rehydration paints Step 6's chrome with the original trigger metadata. Tugcode persists wake-trigger metadata to a sidecar JSONL per [D10]; the replay translator joins on `turn_index` and synthesizes `WakeStartedEvent`s inline within the replay bracket. No `wake_complete` synthesis needed — the replayed `turn_complete` closes it.

**Artifacts:**

- `tugcode/src/wake-trigger-sidecar.ts` (new) — append-only JSONL writer with `fsync` per record; reader returns a `Map<turnIndex, WakeTriggerRecord>`. Tolerates a missing or partially-written file (returns an empty / partial map).
- `tugcode/src/session.ts` — append a sidecar record on every wake bracket emission (both cohorts), tagged with the upcoming turn_index.
- `tugcode/src/replay.ts` — load the sidecar at rehydration time; pass the index to the translator.
- `tugdeck/src/lib/code-session-store/replay/replay-translator.ts` — accept the `wakeTriggers` index; at each turn boundary matching a record, inject a synthesized `WakeStartedEvent` before the assistant_text events.

**Tasks:**

- [ ] Implement `wake-trigger-sidecar.ts` (append + read APIs; missing-file tolerance).
- [ ] Wire sidecar writes into `session.ts` on wake bracket emit.
- [ ] Wire sidecar reads into `replay.ts` at rehydration; pass to translator.
- [ ] Update `replay-translator.ts` to inject `WakeStartedEvent` from sidecar records.
- [ ] Rebuild tugcode binary.

**Tests:**

- [ ] `tugcode/src/__tests__/wake-trigger-sidecar.test.ts` — write + concurrent-read invariants; partial-write tolerance; missing-file degradation.
- [ ] `tugdeck/src/lib/code-session-store/replay/__tests__/replay-wake.test.ts` (new) — replay rehydration with sidecar produces wake-turn chrome equivalent to live; orphan sidecar entries (no matching turn_index) skipped with warn.

**Checkpoint:**

- [ ] `cd tugcode && bun x tsc --noEmit && bun test` green.
- [ ] `cd tugdeck && bun x tsc --noEmit && bun test` green.
- [ ] Rebuild tugcode binary.
- [ ] Manual repro:
  - Live: start session, ScheduleWakeup 60s, observe Step 6's chip.
  - Close Tide. Reopen via session-history (read-only replay path; in-process resume blocked by Step 4's upstream limitation).
  - Rehydrated wake turn paints with the same chip and detail panel.
  - Delete sidecar file; rehydration succeeds; wake turn paints without chrome (graceful degradation).

---

#### Step 8: Slice 2 — system-note rendering for the scheduled prompt {#step-8}

**Depends on:** #step-7

**Commit:** `tide-wake(8): system_note Message for Cohort B scheduled prompts`

**References:** [D11] prompt on wake_started, [D15] add_<kind> naming (add_system_note follows the same template)

**Status:** Deferred. The `system_note` Message kind's only motivating consumer is the rehydrated wake turn that Step 7 was scoped to produce. With Step 7 deferred, building the renderer + reducer wiring + persistence story for a primitive with no current consumer is premature scope. Reconsider alongside Step 7.

**Scope:** Render the registered scheduled prompt as a `system_note` Message inside the wake turn, above the assistant's response. Cohort B only. Realizes [D11]. Requires Step 5 (sequence model) and Step 6 (Cohort B FIFO; the prompt is already captured there).

**Artifacts:**

- `tugcode/src/session.ts` — Step 6's FIFO entry captures the prompt at tool_use time; Step 8 emits it on the wake bracket via `wake_started.wake_trigger.prompt`.
- `tugdeck/src/lib/code-session-store/reducer.ts` — at `handleWakeStarted`, if `wakeTrigger.prompt` is present, append `{ kind: "system_note", text: prompt, source: "scheduled" }` to the wake turn's `messages` array ahead of any assistant_text.
- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` — `CodeRowBody` gains a `system_note` branch in its message-kind dispatch: subdued background, monospace prompt text, "scheduled" prefix label.

**Tasks:**

- [ ] Emit `prompt` on `wake_started.wake_trigger` for Cohort B in `tugcode/src/session.ts`.
- [ ] Append `system_note` Message at `handleWakeStarted` when `prompt` is present.
- [ ] Add a `system_note` branch to `CodeRowBody`'s message-kind dispatch (subdued / monospace / "scheduled" prefix).
- [ ] Rebuild tugcode binary.

**Tests:**

- [ ] Reducer test: `handleWakeStarted` with `wakeTrigger.prompt` appends a `system_note` Message at position 0 of the wake turn's `messages`.
- [ ] Replay round-trip test via Step 7's sidecar: rehydrated wake turn has the same `system_note` Message as live.

**Checkpoint:**

- [ ] `cd tugcode && bun x tsc --noEmit && bun test` green.
- [ ] `cd tugdeck && bun x tsc --noEmit && bun test` green.
- [ ] Rebuild tugcode binary.
- [ ] Manual repro:
  - ScheduleWakeup 60s with prompt "list any commits I made today" → wake turn renders the prompt as a subdued note above the assistant's actual response.
  - CronCreate with multi-line prompt → multi-line preserved.
  - Cohort A wake (Monitor) → no system_note row (no synthetic prompt).
  - Reopened session shows the same system_note on the rehydrated wake turn (via Step 7's sidecar).

---

#### Step 9: Tide-side cancellation of scheduled tasks {#step-9}

**Depends on:** #step-6

**Commit:** `tide-wake(9): cron chip cancel — hidden CronDelete via user_message back-channel`

**References:** [D12] cancellation transport via hidden user_message

**Status:** Deferred. The right-click-the-cron-chip-to-cancel affordance is not load-bearing for v1; direct `/cancel cron <id>` in chat works today via claude's own tool channel. The "hidden user_message back-channel" transport is tricky operating mode (synthetic message can leak into the transcript before suppression, suppression filter has its own lifecycle questions); the polish cost outweighs the user-visible win. Reconsider when a stronger product motivation for in-transcript cancellation surfaces, or when the upstream offers a host-initiated tool channel that doesn't require synthetic user messages.

**Scope:** UI affordance to cancel a recurring scheduled task without typing into chat. Right-click the "Cron" chip from Step 6 → "Cancel" → routes a hidden CronDelete request through the user_message back-channel per [D12]. `ScheduleWakeup` has no cancellation surface — no upstream `WakeDelete` tool exists; one-shot wakes can't be cancelled.

**Artifacts:**

- `tugdeck/src/components/tugways/transcript/transcript-chrome.tsx` — context menu with "Cancel" item; visible only when `WakeTrigger.kind === "cron_create"`.
- `tugdeck/src/lib/code-session-store/store.ts` — `cancelScheduledTask(cron_id)` action that dispatches the IPC frame.
- `tugdeck/src/lib/tugcast/messages.ts` — outbound IPC frame `CancelScheduledTaskFrame { type: "cancel_scheduled_task"; session_id; cron_id; ipc_version: 2 }`.
- `tugcode/src/session.ts` — `handleCancelScheduledTask` IPC handler; inject a hidden user_message ("/cancel cron `<id>`") into claude's stdin; flag the resulting turn for transcript suppression at the tugcode boundary.

**Tasks:**

- [ ] Implement context-menu "Cancel" affordance on the cron chip (gated by `WakeTrigger.kind === "cron_create"`).
- [ ] Implement `cancelScheduledTask(cron_id)` store action.
- [ ] Add `CancelScheduledTaskFrame` outbound IPC type.
- [ ] Implement `handleCancelScheduledTask` on the tugcode side: stdin injection + suppression flag for the resulting turn frames.
- [ ] Rebuild tugcode binary.

**Tests:**

- [ ] `tugcode/src/__tests__/cancellation.test.ts` — end-to-end: IPC frame → hidden user_message injection → suppression of resulting turn frames; chip-vanish state derives from suppressed CronDelete result.

**Known limitation:** claude's brief acknowledgment of the cancellation may flash in the transcript before the suppression filter takes effect. Mitigation: prompt-engineer the synthetic message to request an empty reply; failing that, accept the flash as polish work for a later pass.

**Checkpoint:**

- [ ] `cd tugcode && bun x tsc --noEmit && bun test` green.
- [ ] `cd tugdeck && bun x tsc --noEmit && bun test` green.
- [ ] Rebuild tugcode binary.
- [ ] Manual repro:
  - `CronCreate "* * * * *"` registers; wait for first fire; chip paints.
  - Right-click chip → "Cancel" → chip vanishes; no further fires over a 3-minute hold.
  - Direct CronDelete via chat still works (the two cancellation paths are independent).
  - `ScheduleWakeup` chip context menu has no Cancel item (verified visually).

---

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-5-5, #step-5-6, #step-5-7, #step-5-8, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #spec-wire-frames, #spec-translate-context, #spec-transcript, #spec-z1c)

**Status:** Skipped (plan closed). The message-forward cluster (Steps 5.5–5.8) is covered by its own per-step checkpoints, and the Slice 2 sweep items (chip rehydration / system_note / cron cancel) all live on deferred steps. Straggling wake issues are picked up ad-hoc as they surface during further Tide card work.

**Tasks:**

- [ ] Sweep `#success-criteria` against the running app:
  - Reducer / streaming substrate / snapshot / data source model a turn as a sequence of typed Messages per [D07].
  - Wire interleaving (text → tool → text) paints as three rows in arrival order.
  - Each wake turn paints with a chip identifying its trigger kind (Monitor / Scheduled / Cron) and a click-expand detail panel.
  - After closing and reopening a session, wake turns retain the same chip and detail content.
  - A wake fired by `ScheduleWakeup` / `CronCreate` renders its registered prompt as a subdued `system_note` row above the assistant's response.
  - The user can cancel a recurring scheduled task by right-clicking its chip and choosing "Cancel"; no further fires arrive over a 3-minute hold.
- [ ] Cross-step grep audits (all return zero matches in production code):
  - `grep -rnE "user_message_replay|UserMessageReplay|handleUserMessageReplay" tugcode/src tugdeck/src --include="*.ts"`
  - `grep -rE "pendingUserText|pendingUserAttachments|cycleOpen|cycleMsgId|flushPendingOrphan|pendingWakeFromReplay" tugcode/src`
  - `grep -rE "toolMsgId|ToolBlockProps\.msgId|RenderInput.*msgId\b" tugdeck/src --include="*.tsx" --include="*.ts"`
  - `grep -rE "CodeRowCell|CodeRowBody" tugdeck/src --include="*.ts" --include="*.tsx"`
  - `grep -rE "\\\${turnKey}-(user|code)\\b" tugdeck/src --include="*.ts" --include="*.tsx"` (only `-ghost` should remain)
  - `grep -nE "participant === \"code\".*!turn|!turn.*participant === \"code\"" tugdeck/src/components/tugways/cards/tide-card-z1b.tsx`

**Tests:**

- [ ] `cd tugcode && bun x tsc --noEmit && bun test` green.
- [ ] `cd tugdeck && bun x tsc --noEmit && bun test` green.

**Checkpoint:**

- [ ] Tugcode binary rebuilt against current source.
- [ ] All success criteria above pass in a single manual session covering: simple turns, multi-block turns (text → tool → text), interleaved thinking, multi-iteration tool-use loops, all three wake cohorts (Monitor / Scheduled / Cron), interrupted-before-response turn, in-flight → committed transitions, session close + reopen + chip rehydration, cron cancel.

---

### Lessons Learned {#lessons-learned}

> Discipline that emerged during the phase. Carry forward to every future substrate-level change in the codebase.

#### L01 — A substrate refactor is incomplete until the seams stop leaking {#lesson-substrate-seams}

Step 5 scoped as "change the reducer state shape; change the IPC contract; update consumers to read the new shape." It did NOT scope as "audit every emitter and consumer for residue of the OLD substrate's mental model." That gap is what produced the wake-replay regression — the cycle-pairing in `replay.ts` was a vestige of the paired-substrate's "turn = `user_message_replay` + assistant" contract, and Step 5 left it in place because Step 5's checklist was "does it emit the new IPC events?" not "is the way it does so still appropriate?"

**The general principle.** When a substrate changes, the substrate change is half the work. The other half is verifying that every emitter that produces events for it, and every consumer that reads from it, *thinks* in the new substrate's mental model — not the old one. A substrate refactor is incomplete until its surrounding code stops leaking the old shape at the seams.

**How to detect leaks.** The seams ARE the test: any new case that forces you to add bookkeeping to existing infrastructure (rather than adding one switch arm) is a signal the infrastructure still thinks in the old model and needs to change. The wake-bracket replay-fix that added a third mode to cycle pairing — rather than fitting cleanly into one switch arm — was the signal that the cycle-pairing apparatus needed to retire, not be patched.

**Carry-forward.** Plan substrate-level work end-to-end from the start: substrate + emitters + consumers + render. Don't scope defensively to "just the substrate" and let downstream layers be a future-step problem. The visible render is one of those layers — Steps 5.5–5.8 ratify that the IPC contract, the reducer handlers, the dispatch surface, and the chrome separation were all among the seams Step 5 left behind.

#### L02 — Message-forward propagates through every layer {#lesson-message-forward-end-to-end}

The substrate ([D07]), the IPC contract ([D15], [D16]), the reducer handlers ([D14]), the streaming subscriptions ([D18]), and the chrome separation ([D19]) all had to go message-forward together. Leaving any one paired-shaped creates the next leak.

**Carry-forward.** When a substrate goes message-forward, *all* of its surfaces — IPC emission, IPC consumption, reducer state, snapshot derivation, AND the visible render — must go message-forward together. The substrate's truth must propagate through every layer that surfaces it.

#### L03 — IPC event names should reflect substrate operations, not transport history {#lesson-add-kind-naming}

`user_message_replay` named the *operation that produced the event* (replaying a recorded user message) rather than *what the event does to the substrate* (adds a `user_message` Message). When the substrate became message-forward, the operation-centric name became actively misleading — it kept the reader thinking in terms of paired user/assistant halves.

**Carry-forward.** Name IPC events after the substrate operation they perform. The `add_<kind>` template ([D15]) is the locked pattern for Message-creating events: `add_user_message`, `add_system_note`, and any future Message-creating event. Outbound submissions (`UserMessage` heading to claude) are semantically distinct — they aren't substrate operations; they're transport — and keep operation-centric names. If a symmetric rename is ever desired, the outbound becomes `SubmitUserMessage`.

