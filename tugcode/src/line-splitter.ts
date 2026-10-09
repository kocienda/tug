// line-splitter — the one newline splitter for tugcode's line-delimited
// streams: its own stdin (tugcast's IPC), and claude's stdout and stderr.
//
// Each of those used to carry its own `buffer += decode(chunk);
// indexOf("\n")` loop with no ceiling, so a stream that stopped emitting
// newlines grew a string until the process died. This class owns the
// decoding and the carry, and bounds the carry.

import { logSessionLifecycle } from "./session-lifecycle-log.ts";

/**
 * The longest line, in bytes, a {@link LineSplitter} will deliver: 16 MiB.
 *
 * A stream-json frame is one JSON object per line, and the largest frames
 * claude emits are tool results, which claude truncates itself; the longest
 * line in the stream-json catalog fixtures is under 30 KB. The largest
 * inbound line is a message carrying an image, which `session.ts` caps at
 * 5 MB decoded (`MAX_IMAGE_SIZE_BYTES`), about 7 MB as base64. So 16 MiB
 * sits above any real frame, and far
 * enough below "the process ran out of memory" that a runaway stream is
 * dropped line by line instead of taking tugcode down with it.
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

const NEWLINE = 0x0a;

export interface LineSplitterOptions {
  /** Which stream this is, for the log line a dropped line earns. */
  stream: string;
  /** Lines longer than this many bytes are dropped. Defaults to {@link MAX_LINE_BYTES}. */
  maxLineBytes?: number;
}

/**
 * Splits a byte stream into `\n`-terminated lines.
 *
 * Splitting happens on bytes, before decoding: `0x0A` never occurs inside a
 * multi-byte UTF-8 sequence, so a character split across two chunks is
 * whole by the time its line is decoded. Lines are returned without their
 * `\n` and otherwise verbatim — trimming and skipping empty lines are the
 * caller's business, because stdin wants both and stderr wants neither.
 *
 * A line longer than `maxLineBytes` is dropped, counted in
 * {@link droppedLines}, and logged once (`tugcode.line_dropped`, with the
 * stream name and the line's full byte count) when its end is seen. The
 * splitter discards the line's bytes as they arrive rather than holding
 * them, and resynchronises at the next newline.
 */
export class LineSplitter {
  readonly stream: string;
  readonly maxLineBytes: number;
  private readonly decoder = new TextDecoder();
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** Bytes of the line being dropped so far; `null` when not dropping. */
  private droppingBytes: number | null = null;
  private dropped = 0;

  constructor(options: LineSplitterOptions) {
    this.stream = options.stream;
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  }

  /** How many over-cap lines this splitter has dropped. */
  get droppedLines(): number {
    return this.dropped;
  }

  /** Feed a chunk; returns every line it completed, in order. */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(NEWLINE, start);
      const end = nl === -1 ? chunk.length : nl;
      this.accept(chunk.subarray(start, end));
      if (nl === -1) break;
      const line = this.takeLine();
      if (line !== null) lines.push(line);
      start = nl + 1;
    }
    return lines;
  }

  /**
   * The stream ended: returns the unterminated last line, or `null` when
   * there is none (or when it was over the cap, which is logged as a drop).
   */
  end(): string | null {
    if (this.droppingBytes === null && this.pendingBytes === 0) return null;
    return this.takeLine();
  }

  private accept(segment: Uint8Array): void {
    if (segment.length === 0) return;
    if (this.droppingBytes !== null) {
      this.droppingBytes += segment.length;
      return;
    }
    if (this.pendingBytes + segment.length > this.maxLineBytes) {
      this.droppingBytes = this.pendingBytes + segment.length;
      this.pending = [];
      this.pendingBytes = 0;
      return;
    }
    // Copy: the caller's chunk buffer may be reused after `push` returns.
    this.pending.push(segment.slice());
    this.pendingBytes += segment.length;
  }

  private takeLine(): string | null {
    if (this.droppingBytes !== null) {
      this.dropped += 1;
      logSessionLifecycle("tugcode.line_dropped", {
        stream: this.stream,
        bytes: this.droppingBytes,
        max_line_bytes: this.maxLineBytes,
      });
      this.droppingBytes = null;
      return null;
    }
    let bytes: Uint8Array;
    if (this.pending.length === 1) {
      bytes = this.pending[0];
    } else {
      bytes = new Uint8Array(this.pendingBytes);
      let offset = 0;
      for (const part of this.pending) {
        bytes.set(part, offset);
        offset += part.length;
      }
    }
    this.pending = [];
    this.pendingBytes = 0;
    return this.decoder.decode(bytes);
  }
}
