// ActivityAccumulator — the session's per-channel activity count (Spec S04).
//
// tugcode is the one place the claude stream is parsed, so it is the one
// place per-session work is counted. The accumulator belongs to the session
// rather than to a turn: work that happens with no turn open — a background
// subagent, a task frame between turns — is the session's work as much as a
// turn's is, and a counter that died with the turn could not hold it. The
// session drains it every 250 ms and emits an `activity_delta` whenever a
// channel is non-zero, with or without an open turn.

import type { ActivityChannel } from "./types.ts";
import { isRecord } from "./claude-wire.ts";

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
 * The hum a foreground tool holds while it is in flight. A shell command
 * moves no bytes between its call and its result, so without this the tape
 * reads idle for the whole run — one spike, a flat floor, one spike. Each
 * 250 ms bin in which a foreground tool is open credits this to `tools`,
 * which at 30 units a bin is a rate of 120 per second: about a quarter of
 * full scale, a hum under the call burst and the result rather than a
 * competitor to them. This is the only knob for the level.
 */
const FOREGROUND_TOOL_HUM_UNITS = 30;

export class ActivityAccumulator {
  /**
   * Per-channel work accumulated since the last drain. The subagent /
   * foreground split is expressed as the `subagents` / `tools` channels
   * (keyed off the frame's `parent_tool_use_id`), not by lane — the wire
   * frame is one per-session sample.
   */
  private readonly activity: Record<ActivityChannel, number> = {
    text: 0,
    tokens: 0,
    tools: 0,
    subagents: 0,
  };
  /**
   * Last cumulative `output_tokens` observed per `msg_id`, for token-velocity
   * deltas. `output_tokens` is cumulative within a `msg_id`, so the recorded
   * units are `max(0, cur − last)`, seeded on a new id.
   */
  private readonly tokenByMsgId = new Map<string, number>();
  /** Cumulative `tool_input_progress` bytes per `tool_use_id`, differenced into `text`. */
  private readonly toolInputBytes = new Map<string, number>();
  /** Subagent `tool_use` ids already credited a burst (dedupe by id). */
  private readonly subagentToolSeen = new Set<string>();
  /** Foreground `tool_use` ids already credited a burst (dedupe by id). */
  private readonly foregroundToolSeen = new Set<string>();
  /**
   * Foreground `tool_use` ids currently in flight — added when the call is
   * credited its burst, removed when its `tool_result` lands. While
   * non-empty, every drained bin carries {@link FOREGROUND_TOOL_HUM_UNITS}
   * on `tools`. A backgrounded tool needs no special case: its result lands
   * at once, so its id leaves the set immediately.
   *
   * It is not cleared when a turn ends. A foreground tool whose result has
   * not landed is still running, and the hum says so until the result
   * closes it, turn or no turn.
   */
  private readonly foregroundToolOpen = new Set<string>();
  /**
   * Foreground tool ids a `tool_progress` heartbeat named since the last
   * drain. A heartbeat holds its tool's hum for the bin it lands in, which
   * covers a call whose `tool_use` this count never saw; the set is cleared
   * at every drain, so a heartbeat holds the hum for one bin and no longer.
   */
  private readonly heartbeatOpen = new Set<string>();
  /**
   * Foreground tool ids whose `tool_result` has landed. A heartbeat that
   * arrives after its tool's result names a tool that is no longer running,
   * so it re-opens nothing.
   */
  private readonly foregroundToolClosed = new Set<string>();

  /**
   * Fold one outbound frame into the accumulator. Called for every live
   * frame the session writes to the wire; unrecognized types are ignored.
   * The (parity) rows replicate the deck's former `recordThroughput` field
   * reads and units exactly; the (enhancement) rows — output-token velocity
   * and a foreground `tool_use` burst the deck never counted — are the
   * deliberate, fixture-pinned changes. A frame re-emitted for a replay
   * bracket never reaches it, so replayed history never generates activity.
   */
  accountActivity(frame: object): void {
    const msg: Readonly<Record<string, unknown>> = { ...frame };
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
      if (toolUseId !== null) {
        this.foregroundToolOpen.delete(toolUseId);
        this.heartbeatOpen.delete(toolUseId);
        this.foregroundToolClosed.add(toolUseId);
      }
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
        // re-open a tool nothing will close again.
        this.foregroundToolOpen.add(toolUseId);
      }
    } else if (t === "streaming_usage") {
      // Enhancement: real output-token velocity. `output_tokens` is
      // cumulative within a `msg_id`; record its per-bin growth.
      const usage = isRecord(msg.usage) ? msg.usage : undefined;
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
      // A backgrounded agent's step — a subagent's work, so it lands on
      // `subagents`, beside the agent's own tool calls.
      this.activity.subagents += SUBAGENT_ACTIVITY_UNITS;
    } else if (!parent && t === "tool_progress" && toolUseId !== null) {
      // The engine's heartbeat for a running foreground tool. It keeps the
      // tool's hum up for this bin and adds no units of its own: the hum is
      // the level, and a heartbeat is not work.
      if (!this.foregroundToolClosed.has(toolUseId)) {
        this.heartbeatOpen.add(toolUseId);
      }
    }
  }

  /**
   * Drain the accumulated activity into a wire `channels` object carrying
   * only the non-zero channels, resetting the accumulator. Returns `null`
   * for an idle bin so the flush emits no frame.
   *
   * A bin in which a foreground tool is open is not idle, so the hum is
   * credited here, before the non-zero scan — the hum is what makes such a
   * bin non-empty, and crediting it after the scan would drop the frame it
   * exists to produce.
   */
  drainActivity(): Partial<Record<ActivityChannel, number>> | null {
    if (this.foregroundToolOpen.size > 0 || this.heartbeatOpen.size > 0) {
      this.activity.tools += FOREGROUND_TOOL_HUM_UNITS;
    }
    this.heartbeatOpen.clear();
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
}
