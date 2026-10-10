// ActiveTurn — per-turn mutable state owned by handleUserMessage and
// dispatched-into by the stdout drain task, with the per-block and per-lane
// tracking it keeps and the activity units it credits.

import type {
  ActivityChannel,
  ContentBlock,
  OutboundMessage,
  ToolInputProgress,
} from "./types.ts";
import { IPC_VERSION } from "./types.ts";
import { parseToolInputProgress } from "./event-mapping.ts";

/**
 * Per-turn state for a `handleUserMessage` invocation.
 *
 * Pre-R1e: these were local variables inside `handleUserMessage`'s
 * line-pulling `while (true)` loop. Post-R1e the loop is gone — the
 * stdout drain task reads claude's stdout continuously and dispatches
 * events into an `ActiveTurn` registered by `handleUserMessage`. The
 * turn's `completion` promise resolves when the drain sees
 * `turn_complete` (or claude's stdout closes). `handleUserMessage`
 * awaits that promise rather than pulling lines itself.
 *
 * Pure data + a Promise handle. No I/O. The drain mutates `rev`,
 * `partialText`, `gotResult`, `interrupted` as it processes lines;
 * `handleInterrupt` mutates `interrupted` directly when the user
 * cancels a turn in flight. Single-threaded JS event loop guarantees
 * mutation safety without locks.
 */
/**
 * Per-content-block tracking entry on `ActiveTurn.messageBlocks`. Captures
 * the kind and contents of a single content block (text / thinking /
 * tool_use) as it arrives, so `emitInflightTurnFromActiveTurn` can replay
 * the per-block event stream faithfully on mid-turn reconnect ([D07]
 * § Mid-turn replay snapshot).
 *
 * Discriminated by `kind` — text/thinking variants carry only an
 * accumulating `text` string; tool_use variant carries identity
 * (toolUseId + toolName) plus mutable input/result fields. The
 * discriminated union prevents nonsensical constructions like a "text"
 * block carrying a `toolUseId` from type-checking.
 *
 * Mutation discipline: BlockState fields are mutated IN PLACE by
 * {@link ActiveTurn.updateBlockStateFromMessages} — the `text` string is
 * concatenated, `toolInput` / `toolResult` / `toolStructuredResult` are
 * replaced. The mutability is internal to the owning ActiveTurn and is
 * safe because (a) there are no external subscribers to BlockState
 * references, and (b) the only reader (`emitInflightTurnFromActiveTurn`)
 * runs at a moment when all upstream mutations for the relevant events
 * have already landed. Future contributors: do NOT pass BlockState
 * references to long-lived holders that expect immutability.
 *
 * Tool-result and structured-result data is folded onto the matching
 * tool_use entry — when the wire's `tool_result` lands (via the `user`
 * top-level event), we look up by `toolUseId` (O(1) via
 * {@link ActiveTurn.toolCallByToolUseId}) and stash the output, so a
 * snapshot can emit the full tool lifecycle.
 */
type BlockState = TextBlockState | ThinkingBlockState | ToolUseBlockState;

interface TextBlockState {
  index: number;
  kind: "text";
  /** Accumulated text; appended by text_delta, replaced by terminal text. */
  text: string;
}

interface ThinkingBlockState {
  index: number;
  kind: "thinking";
  /** Accumulated thinking text. */
  text: string;
}

interface ToolUseBlockState {
  index: number;
  kind: "tool_use";
  /** Wire-assigned tool call id; primary key for tool_result correlation. */
  toolUseId: string;
  /** Tool name (e.g. "Bash"). */
  toolName: string;
  /**
   * Tool input. Starts as `{}` at content_block_start time, replaced by
   * the post-`input_json_delta` `tool_use` IPC event with the assembled
   * input. Always present; may be empty.
   */
  toolInput: Record<string, unknown>;
  /**
   * Streaming accumulator for the argument JSON as `input_json_delta`
   * fragments arrive, used to derive `tool_input_progress` frames. Distinct
   * from `toolInput`, which holds the final assembled object.
   */
  partialInputJson?: string;
  /**
   * Last `(file_path|content_lines)` tuple emitted as a `tool_input_progress`
   * frame, so progress emits only when the narratable state changes.
   */
  progressKey?: string;
  /** Populated when the matching `tool_result` lands. */
  toolResult?: { output: string; isError: boolean };
  /** Populated when the matching `tool_use_structured` lands. */
  toolStructuredResult?: Record<string, unknown>;
}

/**
 * Per-lane stream state for one concurrent claude stream within a turn.
 *
 * A turn's stdout multiplexes the main loop's stream with any background
 * subagents' streams; every event is tagged with `parent_tool_use_id`
 * (present on all 5 message types per PN-8) — absent/empty for the main
 * loop, the launching tool_use id for a subagent. Each such source is a
 * **lane**, keyed `parent_tool_use_id ?? null`, and each lane runs its
 * own `message_start` → deltas → `message_delta` cycle with its own
 * `message.id`s. Sharing one pointer across lanes lets a subagent's
 * `message_start` re-stamp the main loop's in-flight deltas with the
 * subagent's msg_id — the reducer then mints a spurious second Message
 * mid-block (the "I / 'll wait…" transcript split).
 */
interface LaneState {
  /**
   * Sliding pointer to the most recent claude `message.id` seen on this
   * lane's stream. Updated on every `message_start` (via
   * `mapStreamEvent.messageId`) and on every top-level `assistant`
   * snapshot (via `routeTopLevelEvent.messageId`). Used by
   * `dispatchEventToTurn` to populate `msg_id` on frames whose claude
   * stream event doesn't carry one directly (`content_block_delta`,
   * `content_block_start`). `null` before the lane's first id-bearing
   * event.
   *
   * Multi-message cycles (text → tool_use → tool_result → second text)
   * overwrite this pointer on the second `message.id`. Each
   * `message.id` is its own thing on the wire; the reducer renders them
   * as separate panels keyed by id.
   */
  msgId: string | null;
  /** Streaming-text revision counter, bumped per stream-event delta. */
  rev: number;
  /** Accumulated streaming text for this lane. */
  partialText: string;
  /**
   * Per-message content blocks observed on this lane, in arrival
   * order. Keyed by msg_id (a lane may span multiple msgIds via
   * tool-use-loop iterations); each value is the ordered list of blocks
   * for that message.
   *
   * Why this lives here rather than being inferred from `partialText`:
   * the wire emits text in discrete blocks separated by tool calls.
   * `partialText` concatenates everything since the lane began (no
   * block boundaries preserved); for a faithful replay snapshot we need
   * the per-block structure too.
   */
  messageBlocks: Map<string, BlockState[]>;
}

/** The main-loop lane key; subagent lanes key by their launching tool_use id. */
const MAIN_LANE: string | null = null;

// ── Activity counting units (Spec S04) ──────────────────────────────────────
// Relocated verbatim from the deck's former `recordThroughput` so the
// producer emits the same magnitudes the sparkline was tuned against. A
// subagent/background beat and a foreground tool call each pulse a fixed
// burst (subagents stream no partial deltas to the parent, so a burst is
// the only signal that keeps the line alive); tool results are credited
// their output length, capped so one large result can't swamp the window.
const SUBAGENT_ACTIVITY_UNITS = 250;
const TOOL_USE_ACTIVITY_UNITS = 250;
const SUBAGENT_RESULT_UNITS_CAP = 600;
const FOREGROUND_RESULT_UNITS_CAP = 600;

/**
 * The hum a foreground tool holds while it is in flight ([B02]). A shell
 * command moves no bytes between its call and its result, so without this the
 * tape reads idle for the whole run — one spike, a flat floor, one spike. Each
 * 250 ms bin in which a foreground tool is open credits this to `tools`, which
 * at 30 units a bin is a rate of 120 per second: about a quarter of full scale,
 * a hum under the call burst and the result rather than a competitor to them.
 * This is the only knob for the level.
 */
const FOREGROUND_TOOL_HUM_UNITS = 30;

export class ActiveTurn {
  /**
   * Per-lane stream state, keyed `parent_tool_use_id ?? null` (see
   * {@link LaneState}). The main lane (`null`) is created eagerly so
   * the accessors below always have a target; subagent lanes are
   * created on their first event via {@link laneFor}.
   */
  private readonly lanes: Map<string | null, LaneState> = new Map([
    [
      MAIN_LANE,
      { msgId: null, rev: 0, partialText: "", messageBlocks: new Map() },
    ],
  ]);

  /**
   * Resolve (creating on first touch) the lane for one event's
   * `parent_tool_use_id ?? null`.
   */
  laneFor(laneKey: string | null): LaneState {
    let lane = this.lanes.get(laneKey);
    if (lane === undefined) {
      lane = { msgId: null, rev: 0, partialText: "", messageBlocks: new Map() };
      this.lanes.set(laneKey, lane);
    }
    return lane;
  }

  /**
   * The MAIN lane's sliding `message.id` pointer (see
   * {@link LaneState.msgId}). Turn-scoped consumers — the terminal
   * emits on `gotResult`, `signalEofToActiveTurn`, and
   * `emitInflightTurnFromActiveTurn` — key on the main loop's message,
   * never a subagent's, so the accessor reads the main lane. `null`
   * before claude's first id-bearing event — degenerate-state emit
   * sites treat null as "nothing claude-keyable to emit yet."
   */
  get currentMessageId(): string | null {
    return this.laneFor(MAIN_LANE).msgId;
  }
  set currentMessageId(value: string | null) {
    this.laneFor(MAIN_LANE).msgId = value;
  }
  /**
   * The MAIN lane's per-message content blocks (see
   * {@link LaneState.messageBlocks}). Read by
   * `emitInflightTurnFromActiveTurn` to reconstruct the per-block event
   * stream for mid-turn replay ([D07] § Mid-turn replay snapshot) —
   * which deliberately replays only the main lane: subagent content is
   * re-derived from the subagent JSONL on the deck side, and replaying
   * it here would inject agent-lane blocks into the main transcript.
   */
  get messageBlocks(): Map<string, BlockState[]> {
    return this.laneFor(MAIN_LANE).messageBlocks;
  }
  /**
   * Index from `tool_use_id` to the matching ToolUseBlockState in
   * {@link messageBlocks}. Maintained alongside `messageBlocks` by
   * `updateBlockStateFromMessages` so that `tool_use` / `tool_result` /
   * `tool_use_structured` events can locate their target block in O(1)
   * — without this index, lookup would walk every msgId's blocks per
   * event, which is O(turns × blocks) per tool event.
   *
   * Same mutation discipline as the BlockState entries themselves: the
   * map value is a reference to the live BlockState in `messageBlocks`,
   * mutated in place.
   */
  toolCallByToolUseId: Map<string, ToolUseBlockState> = new Map();
  /** Outbound `seq` for the user-message half of this turn. */
  readonly seq: number;
  /**
   * Synthesized per-turn opener id (`t-<seq>`), the terminal frames'
   * `msg_id` fallback when claude never revealed a `message.id` this
   * turn. A local-command turn (`/compact`, `/model`, …) streams no
   * assistant message, so {@link currentMessageId} stays null for its
   * whole run; stamping its `turn_complete` with `""` made every such
   * turn share one dedupe key in the reducer's `committedMsgIds` — the
   * second no-content turn's commit was swallowed as a duplicate (the
   * `/compact`-row-vanishes / stuck-Waiting failure). The `t-` prefix
   * is disjoint from claude's real `msg_*` ids and from the replay
   * translator's `u-` / `w-` / `a-` opener namespaces.
   */
  readonly openerId: string;
  /**
   * The user's submitted content blocks, captured by
   * `handleUserMessage` from the inbound `UserMessage`. Source-of-truth
   * for the in-flight turn's synthetic `add_user_message` payload
   * during `runReplay` (mid-turn replay re-emits exactly these
   * blocks). Per Step 5c.
   *
   * Replaces the prior `userText` + `userAttachments` pair — the
   * inbound wire shape is now Anthropic-API content blocks directly,
   * and the synthetic emit forwards them unchanged.
   */
  readonly userContent: ReadonlyArray<ContentBlock>;
  /**
   * Claude's user-prompt-record `uuid` for this turn — the `/rewind`
   * anchor ([#step-7-1]). Captured from the live user-echo event
   * (`--replay-user-messages`) the first time the turn's own submission
   * is echoed back; `null` until then (and for turns whose echo carries
   * no `uuid`). Emitted live as a {@link PromptAnchor} and re-emitted on
   * the mid-turn snapshot's `add_user_message.promptUuid`.
   */
  promptUuid: string | null = null;
  /**
   * Armed-capture flag for the live compaction summary ([P08]). A
   * `compact_boundary` this turn sets it `true`; the next synthetic
   * plain-string `user` event is then captured as a `compact_summary` frame
   * and it flips back to `false` (also disarmed at the turn's `result`).
   */
  pendingCompactSummary = false;
  /** The MAIN lane's streaming-text revision counter (see {@link LaneState.rev}). */
  get rev(): number {
    return this.laneFor(MAIN_LANE).rev;
  }
  set rev(value: number) {
    this.laneFor(MAIN_LANE).rev = value;
  }
  /**
   * The MAIN lane's accumulated streaming text (see
   * {@link LaneState.partialText}); emitted as a final `assistant_text`
   * on `gotResult` and as `turn_cancelled.partial_result` on interrupt.
   */
  get partialText(): string {
    return this.laneFor(MAIN_LANE).partialText;
  }
  set partialText(value: string) {
    this.laneFor(MAIN_LANE).partialText = value;
  }
  /** True once the drain has seen claude's terminal `result` event for this turn. */
  gotResult: boolean = false;
  /**
   * The `usage` of the turn's most recent `message_delta` — the latest
   * tool-loop iteration. `dispatchEventToTurn` emits this as
   * `cost_update.usage` at the terminal `result` event. `null` until
   * the first `message_delta` lands. A fresh `ActiveTurn` per
   * `handleUserMessage` IS the per-turn reset.
   */
  lastMessageDeltaUsage: Record<string, unknown> | null = null;
  /**
   * The `usage` of the turn's most recent `message_start`. The
   * `cost_update.usage` fallback for a degenerate turn that produced no
   * `message_delta` at all (an interrupt before the first iteration's
   * terminal frame). `null` until the first `message_start` lands.
   */
  lastMessageStartUsage: Record<string, unknown> | null = null;
  /** True if `handleInterrupt` was invoked while this turn was active. */
  interrupted: boolean = false;
  /**
   * Why the turn was interrupted, claimed first-writer-wins.
   *
   * `handleInterrupt` claims `"user"`; the result-liveness watchdog's
   * force-terminate claims `"recovery"` only when nothing has claimed it yet.
   * That ordering is what keeps the cancel-escalation ladder the user's: an
   * interrupt claude never acknowledged still escalates through
   * `forceTerminateAndRespawn`, but the gesture that started it was the
   * user's and the frame says so. `null` while the turn is running.
   */
  interruptCause: "user" | "recovery" | null = null;
  /**
   * True if the interrupt was a retraction (`interrupt{retract:true}` —
   * the client's CASE A pull-down). When the turn closes, the manager's
   * close hook truncates the session JSONL at this turn's
   * {@link promptUuid} record and silently respawns, so the aborted
   * prompt leaves claude's history instead of lingering as a
   * phantom-context entry. Meaningless unless {@link interrupted} is
   * also set.
   */
  retractRequested: boolean = false;
  /**
   * Set by `runReplay` when it adopts this turn for in-flight emission
   * (mid-turn replay design). While true, the per-turn `writeLine`
   * sites in `dispatchEventToTurn` and `signalEofToActiveTurn` skip
   * emission but continue to mutate state (`partialText` accumulates,
   * `gotResult`/`interrupted` latch, `finish()` still runs). Cleared
   * by `runReplay`'s `finally` after `replay_complete` is on the wire.
   *
   * Gated emit sites — five in dispatchEventToTurn, two in
   * signalEofToActiveTurn:
   *   1. dispatch: routeResult.messages forwarding
   *   2. dispatch: streamResult.messages forwarding (live deltas)
   *   3. dispatch: control_request_forward
   *   4. dispatch: final complete `assistant_text` on gotResult
   *   5. dispatch: `turn_complete` on gotResult
   *   6. EOF: `turn_cancelled` on interrupted
   *   7. EOF: `error` on unexpected stream end
   */
  suppressEmit: boolean = false;
  /**
   * Per-channel work accumulated since the last activity flush (Spec S04).
   * Drained each 250 ms bin by {@link drainActivity}; the subagent/foreground
   * split is expressed as the `subagents`/`tools` channels (keyed off the
   * event's `parent_tool_use_id`), not by lane — the wire frame is one
   * per-session sample, not per-lane.
   */
  private readonly activity: Record<ActivityChannel, number> = {
    text: 0,
    tokens: 0,
    tools: 0,
    subagents: 0,
  };
  /**
   * Last cumulative `output_tokens` observed per `msg_id`, for token-velocity
   * deltas ([Q01]/[P06]). `output_tokens` is cumulative within a `msg_id`, so
   * the recorded units are `max(0, cur − last)`, seeded on a new id.
   */
  private readonly tokenByMsgId = new Map<string, number>();
  /** Cumulative `tool_input_progress` bytes per `tool_use_id`, differenced into `text`. */
  private readonly toolInputBytes = new Map<string, number>();
  /** Subagent `tool_use` ids already credited a burst (dedupe by id). */
  private readonly subagentToolSeen = new Set<string>();
  /** Foreground `tool_use` ids already credited a burst (dedupe; enhancement row). */
  private readonly foregroundToolSeen = new Set<string>();
  /**
   * Foreground `tool_use` ids currently in flight — added when the call is
   * credited its burst, removed when its `tool_result` lands. While non-empty,
   * every drained bin carries {@link FOREGROUND_TOOL_HUM_UNITS} on `tools`
   * ([B01]). A backgrounded tool needs no special case: its result lands at
   * once, so its id leaves the set immediately ([B03]).
   */
  private readonly foregroundToolOpen = new Set<string>();
  /** Resolves when the turn ends (either via `gotResult` or stdout EOF). */
  readonly completion: Promise<void>;
  private resolveCompletion: (() => void) | null;

  constructor(
    seq: number,
    userContent: ReadonlyArray<ContentBlock>,
  ) {
    this.seq = seq;
    this.openerId = `t-${seq}`;
    this.userContent = userContent;
    let resolve: () => void = () => {};
    this.completion = new Promise<void>((r) => {
      resolve = r;
    });
    this.resolveCompletion = resolve;
  }

  /**
   * Resolve {@link completion}. Idempotent — subsequent calls are
   * no-ops, so the EOF and `gotResult` paths can both call it without
   * coordinating.
   */
  finish(): void {
    if (this.resolveCompletion !== null) {
      this.resolveCompletion();
      this.resolveCompletion = null;
    }
  }

  /**
   * Fold one outbound frame into the activity accumulator (Spec S04). Called
   * for every frame `dispatchEventToTurn` writes to the wire for this turn;
   * unrecognized types are ignored. The (parity) rows replicate the deck's
   * former `recordThroughput` field reads and units exactly; the two
   * (enhancement) rows — output-token velocity replacing the flat
   * `streaming_usage` pip, and a foreground `tool_use` burst the deck never
   * counted — are the deliberate, fixture-pinned changes ([P21]).
   *
   * Only reached inside `dispatchEventToTurn`'s `!suppressEmit` guards, so a
   * replay bracket's re-emitted frames never generate activity — the flush
   * is gated the same way ([Q06]).
   */
  accountActivity(msg: Record<string, unknown>): void {
    const t = msg.type;
    const toolUseId =
      typeof msg.tool_use_id === "string" ? msg.tool_use_id : null;
    const parent =
      typeof msg.parent_tool_use_id === "string" &&
      msg.parent_tool_use_id.length > 0;
    if (
      (t === "assistant_text" || t === "thinking_text") &&
      msg.is_partial === true &&
      typeof msg.text === "string"
    ) {
      this.activity.text += msg.text.length;
    } else if (
      t === "tool_input_progress" &&
      typeof msg.bytes === "number" &&
      toolUseId !== null
    ) {
      const last = this.toolInputBytes.get(toolUseId) ?? 0;
      const delta = msg.bytes - last;
      this.toolInputBytes.set(toolUseId, msg.bytes);
      if (delta > 0) this.activity.text += delta;
    } else if (
      parent &&
      t === "tool_use" &&
      toolUseId !== null &&
      msg.input != null &&
      typeof msg.input === "object" &&
      Object.keys(msg.input as object).length > 0
    ) {
      // A subagent's tool call. Subagents stream no partial deltas to the
      // parent, so this complete frame is the only activity signal — pulse
      // once per call to keep the sparkline alive while an agent works.
      if (!this.subagentToolSeen.has(toolUseId)) {
        this.subagentToolSeen.add(toolUseId);
        this.activity.subagents += SUBAGENT_ACTIVITY_UNITS;
      }
    } else if (parent && t === "tool_result" && typeof msg.output === "string") {
      this.activity.subagents += Math.min(
        msg.output.length,
        SUBAGENT_RESULT_UNITS_CAP,
      );
    } else if (!parent && t === "tool_result") {
      if (toolUseId !== null) this.foregroundToolOpen.delete(toolUseId);
      if (typeof msg.output === "string") {
        this.activity.tools += Math.min(
          msg.output.length,
          FOREGROUND_RESULT_UNITS_CAP,
        );
      }
    } else if (
      !parent &&
      t === "tool_use" &&
      toolUseId !== null &&
      msg.input != null &&
      typeof msg.input === "object" &&
      Object.keys(msg.input as object).length > 0
    ) {
      // Enhancement: a foreground tool call the deck never counted. The
      // burst reads the tool launching as a beat, keeping the line off the
      // floor through an otherwise-silent tool run.
      if (!this.foregroundToolSeen.has(toolUseId)) {
        this.foregroundToolSeen.add(toolUseId);
        this.activity.tools += TOOL_USE_ACTIVITY_UNITS;
        // Opened here rather than beside the branch, so that a re-emitted
        // `tool_use` for an id whose result has already landed cannot
        // re-open a tool nothing will close again ([B01]).
        this.foregroundToolOpen.add(toolUseId);
      }
    } else if (t === "streaming_usage") {
      // Enhancement: real output-token velocity. `output_tokens` is
      // cumulative within a `msg_id`; record its per-bin growth.
      const usage = msg.usage as Record<string, unknown> | undefined;
      const cur =
        usage && typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : 0;
      const msgId = typeof msg.msg_id === "string" ? msg.msg_id : "";
      const last = this.tokenByMsgId.get(msgId) ?? 0;
      this.tokenByMsgId.set(msgId, cur);
      const delta = Math.max(0, cur - last);
      if (delta > 0) this.activity.tokens += delta;
    } else if (t === "task_progress") {
      // A backgrounded agent step; its tool calls don't stream to the
      // parent, so this is the only signal while it runs.
      this.activity.tools += SUBAGENT_ACTIVITY_UNITS;
    }
  }

  /**
   * Drain the accumulated activity into a wire `channels` object carrying
   * only the non-zero channels, resetting the accumulator. Returns `null`
   * for an idle bin so the flush emits no frame ([P15]).
   *
   * A bin in which a foreground tool is open is not idle, so the hum is
   * credited here, before the non-zero scan — the hum is what makes such a
   * bin non-empty, and crediting it after the scan would drop the frame it
   * exists to produce.
   */
  drainActivity(): Partial<Record<ActivityChannel, number>> | null {
    if (this.foregroundToolOpen.size > 0) {
      this.activity.tools += FOREGROUND_TOOL_HUM_UNITS;
    }
    const channels: Partial<Record<ActivityChannel, number>> = {};
    let any = false;
    for (const ch of ["text", "tokens", "tools", "subagents"] as const) {
      const v = this.activity[ch];
      if (v > 0) {
        channels[ch] = v;
        any = true;
      }
      this.activity[ch] = 0;
    }
    return any ? channels : null;
  }

  /**
   * Update {@link messageBlocks} from a batch of emitted IPC messages.
   * Called by `dispatchEventToTurn` after each `routeTopLevelEvent` /
   * `mapStreamEvent` batch — the messages reveal the block events
   * (content_block_start / text deltas / tool_use / tool_result), and
   * this method mirrors them onto per-block state so the mid-turn
   * snapshot path can reconstruct the wire sequence.
   *
   * Pure structural mutation — no I/O, no emit. The same messages are
   * either written to the wire (live) or suppressed (during runReplay's
   * bracket); either way the block state must update so the snapshot is
   * ready if the bracket fires.
   *
   * `laneKey` is the batch's `parent_tool_use_id ?? null` — blocks
   * mirror into that lane's map so a subagent's blocks never collide
   * with (or leak into) the main lane's mid-turn snapshot.
   * `toolCallByToolUseId` stays turn-global: tool_use ids are unique
   * across lanes, and `tool_result` correlation events don't re-state
   * which lane minted the block.
   */
  updateBlockStateFromMessages(
    messages: ReadonlyArray<OutboundMessage>,
    laneKey: string | null = MAIN_LANE,
  ): void {
    const laneBlocks = this.laneFor(laneKey).messageBlocks;
    for (const msg of messages) {
      if (msg.type === "content_block_start") {
        const blocks = laneBlocks.get(msg.msg_id) ?? [];
        // Idempotent: if a block with this index already exists, leave
        // it alone. Mirrors the reducer-side `handleContentBlockStart`
        // idempotence ([D07] § Mid-turn replay snapshot).
        if (blocks.some((b) => b.index === msg.block_index)) {
          continue;
        }
        // Construct the kind-specific BlockState variant. The
        // discriminated union guarantees that the required fields
        // (tool_use_id + tool_name for tool_use blocks) are present at
        // type-check time, so no `?? ""` defensive defaults.
        let entry: BlockState;
        if (msg.kind === "text") {
          entry = { index: msg.block_index, kind: "text", text: "" };
        } else if (msg.kind === "thinking") {
          entry = { index: msg.block_index, kind: "thinking", text: "" };
        } else if (msg.kind === "tool_use") {
          entry = {
            index: msg.block_index,
            kind: "tool_use",
            toolUseId: msg.tool_use_id,
            toolName: msg.tool_name,
            toolInput: {},
          };
          // Index the tool block by tool_use_id for O(1) lookup from
          // subsequent tool_use / tool_result / tool_use_structured
          // events. The map holds a reference to the live BlockState
          // in messageBlocks; mutations to it (input fill, result
          // landing) flow through both views automatically.
          this.toolCallByToolUseId.set(msg.tool_use_id, entry);
        } else {
          // Exhaustiveness check — if a future ContentBlockStart kind
          // is added to the discriminated union, this `never` typecheck
          // fails at compile-time, forcing the mint logic to handle the
          // new case explicitly.
          const _exhaustive: never = msg;
          throw new Error(`unknown content_block_start kind: ${JSON.stringify(_exhaustive)}`);
        }
        blocks.push(entry);
        // Keep blocks sorted by index for predictable iteration.
        blocks.sort((a, b) => a.index - b.index);
        laneBlocks.set(msg.msg_id, blocks);
      } else if (msg.type === "assistant_text" || msg.type === "thinking_text") {
        const blocks = laneBlocks.get(msg.msg_id);
        const block = blocks?.find((b) => b.index === msg.block_index);
        if (block === undefined) {
          // Text delta without a matching minted block — either
          // tugcode emitted out of order or the wire shape regressed.
          // Surface loudly so the bug is detectable; the reducer's
          // own append-or-mutate rule would silently drop too.
          console.error(
            `[tugcode] ${msg.type} (msg_id=${msg.msg_id}, block_index=${msg.block_index}) without a matching content_block_start mint`,
          );
          continue;
        }
        if (block.kind !== "text" && block.kind !== "thinking") {
          // Kind mismatch — a text delta arrived under a tool_use
          // block_index. Wire-shape regression.
          console.error(
            `[tugcode] ${msg.type} for (msg_id=${msg.msg_id}, block_index=${msg.block_index}) targets a ${block.kind} block`,
          );
          continue;
        }
        // is_partial: false (the terminal frame) carries the full text;
        // replace. is_partial: true is a delta; append.
        block.text = msg.is_partial ? block.text + msg.text : msg.text;
      } else if (msg.type === "tool_use") {
        // Tool_use IPC events may carry the final input (post
        // input_json_delta accumulation) — update the matching block's
        // toolInput. O(1) lookup via toolCallByToolUseId.
        const block = this.toolCallByToolUseId.get(msg.tool_use_id);
        if (block === undefined) {
          // No matching block — either tugcode emitted the tool_use
          // without a preceding content_block_start, or the wire
          // shape regressed. Surface loudly.
          console.error(
            `[tugcode] tool_use (tool_use_id=${msg.tool_use_id}) without a matching content_block_start mint`,
          );
          continue;
        }
        if (Object.keys(msg.input).length > 0) {
          block.toolInput = msg.input as Record<string, unknown>;
        }
        block.toolName = msg.tool_name;
      } else if (msg.type === "tool_result") {
        const block = this.toolCallByToolUseId.get(msg.tool_use_id);
        if (block === undefined) {
          // tool_result without a corresponding minted tool_use — the
          // reducer would silently drop. Surface here.
          console.error(
            `[tugcode] tool_result (tool_use_id=${msg.tool_use_id}) without a matching tool_use mint`,
          );
          continue;
        }
        block.toolResult = { output: msg.output, isError: msg.is_error };
      } else if (msg.type === "tool_use_structured") {
        const block = this.toolCallByToolUseId.get(msg.tool_use_id);
        if (block === undefined) {
          console.error(
            `[tugcode] tool_use_structured (tool_use_id=${msg.tool_use_id}) without a matching tool_use mint`,
          );
          continue;
        }
        block.toolStructuredResult = msg.structured_result as Record<string, unknown>;
      }
    }
  }

  /**
   * Accumulate one streaming `input_json_delta` fragment onto its tool block
   * and, when the narratable state advances, return a `tool_input_progress`
   * frame for the caller to emit. Returns null when the block isn't a known
   * tool_use block or when nothing display-relevant changed (throttle).
   *
   * Correlation lives here, not in `mapStreamEvent`: the delta carries only
   * `block_index`, and the block was minted (with its tool_use_id / name) by
   * the preceding `content_block_start` via `updateBlockStateFromMessages`
   * — in the lane the delta arrived on, so `laneKey` selects the same map.
   */
  recordToolInputDelta(
    msgId: string,
    blockIndex: number,
    fragment: string,
    laneKey: string | null = MAIN_LANE,
  ): ToolInputProgress | null {
    const blocks = this.laneFor(laneKey).messageBlocks.get(msgId);
    const block = blocks?.find((b) => b.index === blockIndex);
    if (block === undefined || block.kind !== "tool_use") return null;

    block.partialInputJson = (block.partialInputJson ?? "") + fragment;
    const prog = parseToolInputProgress(block.partialInputJson);
    const lines = prog.contentLines ?? 0;

    // Only Write/Edit-shaped inputs (a file path or growing content) are
    // worth narrating; skip frames that would render as a bare tool name.
    if (prog.filePath === null && lines === 0) return null;

    const key = `${prog.filePath ?? ""}|${lines}`;
    if (key === block.progressKey) return null;
    block.progressKey = key;

    return {
      type: "tool_input_progress",
      msg_id: msgId,
      seq: this.seq,
      block_index: blockIndex,
      tool_use_id: block.toolUseId,
      tool_name: block.toolName,
      bytes: prog.bytes,
      content_lines: lines,
      file_path: prog.filePath,
      ipc_version: IPC_VERSION,
    };
  }
}
