/**
 * subagent-tail.ts — live poll-tailer for a background agent's
 * out-of-band transcript.
 *
 * When Claude Code launches an `Agent` with `run_in_background: true`,
 * the agent's child tool calls and final answer are written to a
 * live-growing JSONL file (`tasks/<agentId>.output`, the `outputFile`
 * path carried by the async-launch echo) — never to the parent
 * session's stream. This module tails that file from a byte offset and
 * re-emits each newly-appended entry as the same `parent_tool_use_id`
 * child frames the resume splice synthesizes
 * (`synthesizeSubagentChildFrames`), so live and reload converge on
 * byte-identical frame shapes.
 *
 * Mechanics:
 *  - **Poll, don't watch.** `fs.watch` is unreliable for file appends
 *    on macOS; the tailer reads from a persisted byte offset on an
 *    interval (default ~250 ms).
 *  - **Complete lines only.** Bytes after the last newline are carried
 *    as a pending remainder across polls (as raw bytes, so a UTF-8
 *    code point split at the read boundary never mis-decodes); the
 *    offset advances past everything read, and only fully-terminated
 *    lines are parsed and emitted.
 *  - **Compose on genuine completion only.** The parent Agent's
 *    `tool_use_structured` (final answer + footer stats, via
 *    `composeAgentStructuredResult`) is emitted exactly once, from
 *    `stop(finalFlush = true)` — never mid-stream, so an intermediate
 *    "let me…" line is never surfaced as the answer.
 *  - **Best-effort everywhere.** A missing file is a no-op, a
 *    malformed line is skipped, and no code path throws into the
 *    caller — the session's stdout drain must never die because a
 *    background agent's file misbehaved.
 *
 * On a deck reconnect the owning session calls `resetForReplay()` so
 * the tailer re-streams the full child set from offset 0 into the
 * re-hydrated job; the deck's id-keyed dedup absorbs the overlap with
 * the replay's turn-attached children.
 *
 * @module subagent-tail
 */

import { open, stat } from "node:fs/promises";

import {
  composeAgentStructuredResult,
  synthesizeSubagentChildFrames,
  type JsonlEntry,
  type SubagentTranscript,
} from "./replay.ts";
import type { OutboundMessage, ToolUseStructured } from "./types.ts";
import { IPC_VERSION } from "./types.ts";

/** Default poll cadence — cheap enough to feel live, coarse enough to idle. */
export const DEFAULT_TAIL_INTERVAL_MS = 250;

export interface SubagentTailerOptions {
  /** The launching `Agent` call's `tool_use.id` — stamps every child frame. */
  parentToolUseId: string;
  /** The background agent's id (the tailer map key; diagnostics only here). */
  agentId: string;
  /** Absolute path of the live-growing transcript (`tasks/<agentId>.output`). */
  outputFile: string;
  /** Frame sink — the session passes `writeLine`. */
  emit: (frame: OutboundMessage) => void;
  /** Shared live-sequence source, threaded into the synthesized frames. */
  nextSeq: () => number;
  /** Poll cadence override (tests drive `poll()` directly instead). */
  intervalMs?: number;
}

/**
 * Poll-tails one background agent's `outputFile`, emitting child frames
 * for each newly-appended transcript entry and, on genuine completion,
 * the parent's composed `tool_use_structured`.
 */
export class SubagentTailer {
  readonly parentToolUseId: string;
  readonly agentId: string;
  readonly outputFile: string;

  private readonly emit: (frame: OutboundMessage) => void;
  private readonly nextSeq: () => number;
  private readonly intervalMs: number;

  /** Byte offset of the next unread byte in `outputFile`. */
  private offset = 0;
  /** Raw bytes after the last newline — an incomplete trailing line. */
  private pending: Buffer = Buffer.alloc(0);
  /** Every entry parsed so far — the compose input on completion. */
  private entries: JsonlEntry[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Re-entrancy latch — a slow poll must not overlap the next tick. */
  private polling = false;
  private stopped = false;
  private composed = false;

  constructor(options: SubagentTailerOptions) {
    this.parentToolUseId = options.parentToolUseId;
    this.agentId = options.agentId;
    this.outputFile = options.outputFile;
    this.emit = options.emit;
    this.nextSeq = options.nextSeq;
    this.intervalMs = options.intervalMs ?? DEFAULT_TAIL_INTERVAL_MS;
  }

  /** Begin polling on the configured interval. Idempotent. */
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  /**
   * Rewind to the start of the file so the next poll re-streams the
   * agent's full child set — the deck-reconnect path. The deck's
   * id-keyed dedup fuses the re-streamed frames with the replay's
   * turn-attached children.
   */
  resetForReplay(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.entries = [];
  }

  /**
   * Read and emit everything appended since the last poll. Best-effort:
   * a missing/unreadable file is a no-op, malformed lines are skipped,
   * and nothing thrown here escapes to the caller.
   */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      await this.drainNewBytes();
    } catch {
      // Missing file, transient read error — try again next tick.
    } finally {
      this.polling = false;
    }
  }

  /**
   * Stop polling. With `finalFlush` (genuine completion, or claude
   * exit) drain any remaining appended lines, then compose + emit the
   * parent's `tool_use_structured` exactly once. Never throws.
   *
   * The final drain **settles** rather than reading once: the
   * completion signal (`task_notification` / terminal `task_updated`)
   * can land on the wire a beat before Claude Code appends the agent's
   * final answer entry to the transcript file. A single read at that
   * moment composes an intermediate line as the answer — the exact
   * symptom the compose-on-completion rule exists to prevent. So the
   * flush re-polls until the file has been quiet for two consecutive
   * reads (or a small cap), then composes.
   */
  async stop(finalFlush: boolean): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.stopped) return;
    if (finalFlush) {
      let quietReads = 0;
      for (let attempt = 0; attempt < 12 && quietReads < 2; attempt++) {
        let grew = false;
        try {
          grew = await this.drainNewBytes();
        } catch {
          // Missing/unreadable counts as quiet — compose from what we have.
        }
        quietReads = grew ? 0 : quietReads + 1;
        if (quietReads < 2) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      if (!this.composed) {
        this.composed = true;
        try {
          const structured: ToolUseStructured = {
            type: "tool_use_structured",
            tool_use_id: this.parentToolUseId,
            tool_name: "Agent",
            structured_result: composeAgentStructuredResult(this.transcript()),
            ipc_version: IPC_VERSION,
          };
          this.emit(structured);
        } catch {
          // A compose failure must not kill the session loop.
        }
      }
    }
    this.stopped = true;
  }

  /** The accumulated transcript in the shape the replay helpers consume. */
  private transcript(entries: JsonlEntry[] = this.entries): SubagentTranscript {
    return { meta: { toolUseId: this.parentToolUseId }, entries };
  }

  /**
   * Read from the byte offset, parse complete lines, emit their
   * frames. Returns `true` when new bytes were consumed (the settle
   * loop in {@link stop} uses this as its file-quiet signal).
   */
  private async drainNewBytes(): Promise<boolean> {
    const st = await stat(this.outputFile);
    if (st.size < this.offset) {
      // The file shrank (rotated / rewritten): start over. Re-emitted
      // frames are id-keyed, so the deck dedups the overlap.
      this.resetForReplay();
    }
    if (st.size === this.offset) return false;

    const length = st.size - this.offset;
    const chunk = Buffer.alloc(length);
    const fh = await open(this.outputFile, "r");
    let bytesRead = 0;
    try {
      bytesRead = (await fh.read(chunk, 0, length, this.offset)).bytesRead;
    } finally {
      await fh.close();
    }
    if (bytesRead <= 0) return false;
    this.offset += bytesRead;

    const data = Buffer.concat([this.pending, chunk.subarray(0, bytesRead)]);
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      this.pending = data;
      return true;
    }
    this.pending = Buffer.from(data.subarray(lastNewline + 1));

    const fresh: JsonlEntry[] = [];
    for (const rawLine of data.subarray(0, lastNewline).toString("utf8").split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      try {
        fresh.push(JSON.parse(line) as JsonlEntry);
      } catch {
        // Skip the malformed line; later lines still stream.
      }
    }
    if (fresh.length === 0) return true;
    this.entries.push(...fresh);

    for (const frame of synthesizeSubagentChildFrames(
      this.transcript(fresh),
      this.nextSeq,
    )) {
      this.emit(frame);
    }
    return true;
  }
}
