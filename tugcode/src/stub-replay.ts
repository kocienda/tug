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
// `paceMs`, when present, is the delay between one output and the
// next within a turn — a token cadence, so a turn streams rather than
// arriving as one burst. Absent or zero, a turn's outputs are emitted in
// one loop, as they always were.
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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  ContentBlockStart,
} from "./types.ts";
import { IPC_VERSION } from "./types.ts";
import { errorFrame } from "./ipc.ts";
import type { ReplayAfterTurn, ReplayWindow } from "@tugproto/inbound";

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
  | ResumeFailed
  | ContentBlockStart;

/**
 * The transcript document loaded from `--stub-transcript=<path>`.
 */
export interface TugcodeTranscript {
  schemaVersion: number;
  tugcodeVersion: string;
  /**
   * Milliseconds between one output and the next within a turn. Absent
   * or zero emits a turn's outputs at once.
   */
  paceMs?: number;
  turns: TugcodeTurn[];
}

/**
 * The environment variable naming a directory of per-session stub
 * transcripts. tugcast spawns every session's tugcode itself, so a test
 * that wants one card's session replayed — rather than run against
 * claude — cannot pass `--stub-transcript`. It sets this variable on the
 * app instead, and writes `<dir>/<session id>.json` for each session it
 * wants stubbed; every other session runs live.
 */
export const STUB_TRANSCRIPT_DIR_ENV = "TUGCODE_STUB_TRANSCRIPT_DIR";

/**
 * The stub transcript this session replays under
 * {@link STUB_TRANSCRIPT_DIR_ENV}, or `undefined` when the variable is
 * unset or holds no transcript for `sessionId`.
 */
export function stubTranscriptForSession(
  env: Record<string, string | undefined>,
  sessionId: string,
): string | undefined {
  const dir = env[STUB_TRANSCRIPT_DIR_ENV];
  if (dir === undefined || dir === "") return undefined;
  const path = join(dir, `${sessionId}.json`);
  return existsSync(path) ? path : undefined;
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
  const pace = obj.paceMs;
  if (pace !== undefined && (typeof pace !== "number" || !(pace >= 0))) {
    throw new Error(
      `stub-replay: transcript at ${path} has paceMs=${String(pace)} (must be a number >= 0)`,
    );
  }
  return {
    schemaVersion: sv,
    tugcodeVersion: obj.tugcodeVersion,
    paceMs: pace,
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
  /** The paced turns, chained so a second turn never interleaves the first. */
  private pacing: Promise<void> = Promise.resolve();
  /**
   * What the turn dispatched last has put on the wire so far — the record
   * {@link requestInflight} describes it from, as production tugcode
   * describes its turn from `ActiveTurn`.
   */
  private turnSent: OutboundMessage[] = [];
  /**
   * Every turn that has put its end on the wire, in order: what a replay
   * with a `turnRange` or an `afterTurn` reads back, as production reads its
   * JSONL.
   */
  private turnsDone: OutboundMessage[][] = [];
  /** Whether the turn dispatched last has put its end on the wire (true before any). */
  private turnEnded = true;

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
      ipc_version: IPC_VERSION,
    };
    this.emit(ack);
    const init: SessionInit = {
      type: "session_init",
      session_id: this.sessionId,
      ipc_version: IPC_VERSION,
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
      // A paced turn may still be streaming: the error follows its last
      // output rather than landing in the middle of it.
      if ((this.transcript.paceMs ?? 0) > 0) {
        this.pacing = this.pacing.then(() => this.emit(err));
      } else {
        this.emit(err);
      }
      return false;
    }
    const turn = this.transcript.turns[this.nextTurnIndex];
    this.nextTurnIndex++;
    const paceMs = this.transcript.paceMs ?? 0;
    if (paceMs <= 0) {
      this.turnSent = [];
      this.turnEnded = false;
      for (const output of turn.outputs) {
        this.sendTurnOutput(output);
      }
      return true;
    }
    this.pacing = this.pacing.then(async () => {
      this.turnSent = [];
      this.turnEnded = false;
      for (let i = 0; i < turn.outputs.length; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
        this.sendTurnOutput(turn.outputs[i]);
      }
    });
    return true;
  }

  private sendTurnOutput(output: OutboundMessage): void {
    this.turnSent.push(output);
    this.emit(output);
    if (output.type === "turn_complete" || output.type === "turn_cancelled") {
      this.turnEnded = true;
      this.turnsDone.push([...this.turnSent]);
    }
  }

  /**
   * Answer `request_inflight` as production tugcode does: a bracket marked
   * `inflight_only` around a snapshot of the turn dispatched last, in flight
   * or finished. The snapshot is composed the way
   * `emitInflightTurnFromActiveTurn` composes one — its opener marked
   * `inflightSnapshot`, each block opened and its text whole as it now
   * stands, and the turn's end if it has been sent — from what this engine
   * has emitted, so a card whose socket dropped mid-turn reads what it
   * missed. Emitted at once, beside a paced turn still streaming.
   */
  requestInflight(): void {
    this.emit({ type: "replay_started", inflight_only: true, ipc_version: IPC_VERSION } as OutboundMessage);
    if (this.turnSent.length > 0) this.emitSnapshot(this.turnSent);
    this.emit({ type: "replay_complete", count: 0, ipc_version: IPC_VERSION } as OutboundMessage);
  }

  /**
   * A turn as a snapshot of what it has put on the wire: its opener marked
   * `inflightSnapshot`, each block opened and its text whole as it now
   * stands, and its end if it has been sent.
   */
  private emitSnapshot(sent: readonly OutboundMessage[]): void {
    this.emit({
      type: "add_user_message",
      content: [],
      inflightSnapshot: true,
      ipc_version: IPC_VERSION,
    } as unknown as OutboundMessage);
    const blocks = new Map<string, { start: ContentBlockStart | null; text: AssistantText | null; whole: string }>();
    let end: OutboundMessage | null = null;
    for (const output of sent) {
      if (output.type === "content_block_start") {
        const key = `${output.msg_id}:${output.block_index}`;
        const block = blocks.get(key) ?? { start: null, text: null, whole: "" };
        block.start = output;
        blocks.set(key, block);
      } else if (output.type === "assistant_text") {
        const key = `${output.msg_id}:${output.block_index}`;
        const block = blocks.get(key) ?? { start: null, text: null, whole: "" };
        block.whole = output.is_partial ? block.whole + output.text : output.text;
        block.text = output;
        blocks.set(key, block);
      } else if (output.type === "turn_complete" || output.type === "turn_cancelled") {
        end = output;
      }
    }
    for (const block of blocks.values()) {
      if (block.start !== null) this.emit(block.start);
      if (block.text !== null) {
        this.emit({ ...block.text, text: block.whole, is_partial: false, status: "streaming" });
      }
    }
    if (end !== null) this.emit(end);
  }

  /**
   * Answer `request_replay`. A stub session keeps no JSONL, so a read of the
   * session — a launch, an open — has nothing to read back, and says so the
   * way production tugcode does for a session with nothing to read: an empty
   * bracket. Without it a stub card never finishes its first read, which a
   * real one always does.
   *
   * A read of a `turnRange`, or of an `afterTurn` — a dormant body catching
   * up on what it missed — is answered from the turns this engine has
   * finished, as production answers from its JSONL: each finished turn in the
   * range as replay carries a committed one (its opener, each block whole,
   * its end), then a snapshot of a turn still streaming, and the window the
   * bracket covered. An `afterTurn` is placed as production places it: after
   * the newest finished turn carrying a named msg-id, else one turn before
   * the count the card holds.
   */
  answerReplay(window?: ReplayWindow): void {
    this.emit({ type: "replay_started", ipc_version: IPC_VERSION } as OutboundMessage);
    if (window === undefined || "lastTurns" in window) {
      this.emit({ type: "replay_complete", count: 0, ipc_version: IPC_VERSION } as OutboundMessage);
      return;
    }
    const total = this.turnsDone.length;
    const [rawFirst, rawEnd] =
      "turnRange" in window ? window.turnRange : [this.turnAfter(window.afterTurn), total];
    const first = Math.max(0, Math.min(Math.floor(rawFirst), total));
    const end = Math.max(first, Math.min(Math.floor(rawEnd), total));
    for (let i = first; i < end; i++) {
      this.emit({ type: "add_user_message", content: [], ipc_version: IPC_VERSION } as unknown as OutboundMessage);
      for (const output of this.turnsDone[i]) {
        if (output.type === "assistant_text" && output.is_partial) continue;
        this.emit(output);
      }
    }
    if (!this.turnEnded && this.turnSent.length > 0) this.emitSnapshot(this.turnSent);
    this.emit({
      type: "replay_complete",
      count: end - first,
      firstLoadedTurnIndex: first,
      totalTurns: total,
      hasOlder: first > 0,
      ipc_version: IPC_VERSION,
    } as unknown as OutboundMessage);
  }

  /** The first finished turn after the newest one the card names, as production's `turnAfterHeld` finds it. */
  private turnAfter(held: ReplayAfterTurn): number {
    for (const id of held.msgIds) {
      for (let i = this.turnsDone.length - 1; i >= 0; i--) {
        if (this.turnsDone[i].some((m) => "msg_id" in m && m.msg_id === id)) return i + 1;
      }
    }
    return Math.max(0, Math.floor(held.heldTurns) - 1);
  }

  /** Resolves when every paced turn dispatched so far has emitted its last output. */
  get paced(): Promise<void> {
    return this.pacing;
  }

  /**
   * Read-only accessor for the engine's current turn cursor.
   * Useful in tests that need to assert dispatch progress.
   */
  get currentTurnIndex(): number {
    return this.nextTurnIndex;
  }
}
