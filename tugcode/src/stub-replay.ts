// stub-replay.ts — deterministic transcript replay for harness tests.
//
// When tugcode launches with `--stub-transcript=<path>`, main.ts
// routes the IPC loop through this module instead of SessionManager.
// The replay engine loads a structured transcript at startup,
// emits a synthetic ProtocolAck + SessionInit on protocol_init, and
// then maps each incoming UserMessage to the matching turn's
// recorded outputs.
//
// ## Why a dedicated replay engine
//
// Production tugcode spawns claude and shuttles stream-json bytes
// between the model and tugcast. That path is non-deterministic
// (model output varies turn-to-turn) and slow (model latency).
// Tests that need deterministic IPC sequences — especially EM-card
// tests where the harness asserts on streamed text content —
// cannot use the live path. Replay is the alternative: capture a
// real transcript once via `scripts/capture-tugcode-transcript.ts`,
// commit it, replay it deterministically across test runs.
//
// ## Format
//
// The transcript is a single JSON document at `--stub-transcript=<path>`:
//
// ```json
// {
//   "schemaVersion": 1,
//   "tugcodeVersion": "0.8.0",
//   "turns": [
//     {
//       "index": 0,
//       "outputs": [
//         { "type": "assistant_text", ... },
//         { "type": "turn_complete", ... }
//       ],
//       "description": "hello world"
//     }
//   ]
// }
// ```
//
// Schema version mismatch produces a hard error at load time. The
// `tugcodeVersion` field is informational at this Pass 7B scope —
// runtime version-handshake / mismatch handling is deferred to a
// follow-up.
//
// ## Matching strategy
//
// Turn matching is index-based: the N-th `user_message` arriving
// over stdin advances to turn N's outputs. The transcript's
// `turns[].index` field MUST equal the array index for the turn
// to be considered well-formed (the load step verifies this).
// This makes replay invariant to the prompt content — the user
// can change their input message between capture and replay
// without invalidating the transcript, as long as turn ordering
// is preserved.
//
// Out-of-bounds turns (more user_messages than the transcript
// covers) emit an `error` event with `recoverable: false` and
// shut down. Underrun (fewer user_messages than turns) is fine
// — extra turns are simply not played.

import { readFileSync } from "node:fs";
import type {
  AssistantText,
  ErrorEvent,
  OutboundMessage,
  ProtocolAck,
  SessionInit,
  ThinkingText,
  ToolApprovalRequest,
  ToolUse,
  ToolResult,
  ToolUseStructured,
  TurnCancelled,
  TurnComplete,
  Question,
  ControlRequestForward,
  SystemMetadata,
  CostUpdate,
  CompactBoundary,
  CompactSummary,
  ApiRetry,
  ControlRequestCancel,
  ResumeFailed,
} from "./types.ts";
import { errorFrame } from "./ipc.ts";

/**
 * Schema version of the transcript document. Bumped when the
 * `TugcodeTranscript` shape changes incompatibly. A transcript
 * with a higher schemaVersion than this constant is rejected at
 * load time.
 */
export const TRANSCRIPT_SCHEMA_VERSION = 1 as const;

/**
 * One replay turn — the outputs to emit when the N-th
 * `user_message` arrives. `index` MUST equal the array position
 * of this turn in `TugcodeTranscript.turns` (verified at load).
 */
export interface TugcodeTurn {
  index: number;
  /** Optional human-readable hint for debugging — not consumed at runtime. */
  description?: string;
  outputs: TranscriptOutboundMessage[];
}

/**
 * Outbound messages a transcript may carry. Subset of the full
 * `OutboundMessage` union — `protocol_ack` and `session_init` are
 * synthesized by the replay engine itself, not authored in the
 * transcript.
 */
export type TranscriptOutboundMessage =
  | AssistantText
  | ToolUse
  | ToolResult
  | ToolApprovalRequest
  | Question
  | TurnComplete
  | TurnCancelled
  | ErrorEvent
  | ThinkingText
  | ControlRequestForward
  | SystemMetadata
  | CostUpdate
  | CompactBoundary
  | CompactSummary
  | ApiRetry
  | ToolUseStructured
  | ControlRequestCancel
  | ResumeFailed;

/**
 * The transcript document loaded from `--stub-transcript=<path>`.
 */
export interface TugcodeTranscript {
  schemaVersion: number;
  tugcodeVersion: string;
  turns: TugcodeTurn[];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate a transcript from `path`. Throws a descriptive
 * `Error` on:
 *   - file read / parse failure
 *   - missing required fields
 *   - schema version mismatch
 *   - turns whose `index` does not match their array position
 *
 * The thrown errors carry their reason in the message so the caller
 * (main.ts) can write a single `error` IPC event and exit cleanly.
 */
export function loadTranscript(path: string): TugcodeTranscript {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`stub-replay: failed to read transcript at ${path}: ${err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`stub-replay: transcript at ${path} is not valid JSON: ${err}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `stub-replay: transcript at ${path} must be a JSON object`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const sv = obj.schemaVersion;
  if (typeof sv !== "number") {
    throw new Error(
      `stub-replay: transcript at ${path} missing numeric schemaVersion`,
    );
  }
  if (sv !== TRANSCRIPT_SCHEMA_VERSION) {
    throw new Error(
      `stub-replay: transcript schemaVersion ${sv} is not supported (expected ${TRANSCRIPT_SCHEMA_VERSION})`,
    );
  }
  if (typeof obj.tugcodeVersion !== "string") {
    throw new Error(
      `stub-replay: transcript at ${path} missing string tugcodeVersion`,
    );
  }
  if (!Array.isArray(obj.turns)) {
    throw new Error(
      `stub-replay: transcript at ${path} missing turns[] array`,
    );
  }
  const turns: TugcodeTurn[] = [];
  for (let i = 0; i < obj.turns.length; i++) {
    const t = obj.turns[i];
    if (typeof t !== "object" || t === null) {
      throw new Error(`stub-replay: turn ${i} is not an object`);
    }
    const turn = t as Record<string, unknown>;
    if (turn.index !== i) {
      throw new Error(
        `stub-replay: turn ${i} has index=${turn.index} (must equal array position)`,
      );
    }
    if (!Array.isArray(turn.outputs)) {
      throw new Error(`stub-replay: turn ${i} missing outputs[] array`);
    }
    turns.push({
      index: i,
      description: typeof turn.description === "string" ? turn.description : undefined,
      outputs: turn.outputs as TranscriptOutboundMessage[],
    });
  }
  return {
    schemaVersion: sv,
    tugcodeVersion: obj.tugcodeVersion,
    turns,
  };
}

// ---------------------------------------------------------------------------
// Replay engine
// ---------------------------------------------------------------------------

/**
 * Stateful turn dispatcher. One instance per tugcode lifetime.
 * Tracks the current turn index; advances on each `dispatchTurn`
 * call. `synthesizeHandshake` runs once at startup to emit the
 * non-turn ProtocolAck + SessionInit.
 */
export class StubReplayEngine {
  private readonly transcript: TugcodeTranscript;
  private readonly emit: (msg: OutboundMessage) => void;
  private readonly sessionId: string;
  private nextTurnIndex = 0;

  constructor(args: {
    transcript: TugcodeTranscript;
    sessionId: string;
    emit: (msg: OutboundMessage) => void;
  }) {
    this.transcript = args.transcript;
    this.emit = args.emit;
    this.sessionId = args.sessionId;
  }

  /**
   * Emit the protocol_ack + session_init pair that production
   * tugcode emits during `SessionManager.initialize()`. The
   * replay path skips claude-spawn entirely; we still need these
   * frames so tugcast / tugdeck see a valid handshake.
   */
  synthesizeHandshake(protocolVersion: number): void {
    const ack: ProtocolAck = {
      type: "protocol_ack",
      version: protocolVersion,
      session_id: this.sessionId,
      ipc_version: 2,
    };
    this.emit(ack);
    const init: SessionInit = {
      type: "session_init",
      session_id: this.sessionId,
      ipc_version: 2,
    };
    this.emit(init);
  }

  /**
   * Emit the next turn's outputs. Called by main.ts on each
   * UserMessage receipt. Out-of-bounds turns produce an `error`
   * event and signal "should exit" via the return value.
   *
   * @returns `true` when the turn dispatched cleanly; `false` when
   *          the engine has exhausted its turns (caller should
   *          shut down).
   */
  dispatchTurn(): boolean {
    if (this.nextTurnIndex >= this.transcript.turns.length) {
      const err: ErrorEvent = errorFrame(
        "stub_replay_exhausted",
        `stub-replay: user_message ${this.nextTurnIndex} exceeds transcript length ${this.transcript.turns.length}`,
        false,
      );
      this.emit(err);
      return false;
    }
    const turn = this.transcript.turns[this.nextTurnIndex];
    this.nextTurnIndex++;
    for (const output of turn.outputs) {
      this.emit(output);
    }
    return true;
  }

  /**
   * Read-only accessor for the engine's current turn cursor.
   * Useful in tests that need to assert dispatch progress.
   */
  get currentTurnIndex(): number {
    return this.nextTurnIndex;
  }
}
