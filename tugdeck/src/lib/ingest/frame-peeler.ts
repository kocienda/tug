/**
 * `FramePeeler` — reassembles tugcast's length-prefixed frames from the
 * chunks a WebSocket delivers, without re-copying the unread tail.
 *
 * WebSocket message boundaries are not frame boundaries here: the `/ws`
 * proxy may split one frame across several messages and coalesce several
 * frames into one. So every chunk is appended to one growable buffer, and
 * every complete frame is peeled off its front.
 *
 * The buffer keeps a read offset and a write offset. A chunk is copied in
 * once; a complete frame's payload is copied out once, into its own
 * `ArrayBuffer`, which the caller can then transfer. Nothing re-slices the
 * remaining bytes per frame — the read offset just moves. The unread bytes
 * are moved to the front only when the read offset passes half the
 * capacity, and the capacity doubles when a chunk does not fit.
 *
 * An oversized length field means the stream is desynced from the sender's
 * frames and cannot be recovered: the buffer resets and the reset is
 * reported, and the lost frame counts as a dropped wire event.
 */

import { HEADER_SIZE, MAX_PAYLOAD_SIZE } from "@/protocol";

/** One complete frame: its header fields and its payload, in a buffer of its own. */
export interface PeeledFrame {
  feedId: number;
  flags: number;
  payload: ArrayBuffer;
}

const INITIAL_CAPACITY = 64 * 1024;

export class FramePeeler {
  private buf: Uint8Array;
  private read = 0;
  private write = 0;

  /** Bytes copied into and within the buffer, and out of it into payloads. */
  readonly copies = { inBytes: 0, compactBytes: 0, compactions: 0, outBytes: 0 };

  constructor(
    private readonly onOversized: (length: number) => void = () => {},
    initialCapacity: number = INITIAL_CAPACITY,
  ) {
    this.buf = new Uint8Array(initialCapacity);
  }

  /** Bytes held and not yet peeled. */
  get pending(): number {
    return this.write - this.read;
  }

  /** The buffer's current capacity. */
  get capacity(): number {
    return this.buf.length;
  }

  /** Drop everything held, as a closed socket's partial frame must be. */
  reset(): void {
    this.read = 0;
    this.write = 0;
  }

  /** Append one chunk and return every frame it completed, in order. */
  push(chunk: Uint8Array): PeeledFrame[] {
    this.append(chunk);
    const frames: PeeledFrame[] = [];
    while (this.write - this.read >= HEADER_SIZE) {
      const b = this.buf;
      const r = this.read;
      const length = ((b[r + 2]! << 24) >>> 0) + (b[r + 3]! << 16) + (b[r + 4]! << 8) + b[r + 5]!;
      if (length > MAX_PAYLOAD_SIZE) {
        this.reset();
        this.onOversized(length);
        break;
      }
      if (this.write - r < HEADER_SIZE + length) break;
      const start = r + HEADER_SIZE;
      const payload = b.slice(start, start + length).buffer;
      this.copies.outBytes += length;
      frames.push({ feedId: b[r]!, flags: b[r + 1]!, payload });
      this.read = start + length;
    }
    if (this.read === this.write) {
      this.read = 0;
      this.write = 0;
    } else if (this.read > this.buf.length / 2) {
      this.compact();
    }
    return frames;
  }

  private append(chunk: Uint8Array): void {
    if (this.write + chunk.length > this.buf.length) {
      if (this.read > 0) this.compact();
      if (this.write + chunk.length > this.buf.length) {
        let capacity = this.buf.length;
        while (capacity < this.write + chunk.length) capacity *= 2;
        const next = new Uint8Array(capacity);
        next.set(this.buf.subarray(0, this.write));
        this.copies.compactBytes += this.write;
        this.buf = next;
      }
    }
    this.buf.set(chunk, this.write);
    this.write += chunk.length;
    this.copies.inBytes += chunk.length;
  }

  /** Move the unread bytes to index 0. */
  private compact(): void {
    const unread = this.write - this.read;
    this.buf.copyWithin(0, this.read, this.write);
    this.copies.compactBytes += unread;
    this.copies.compactions += 1;
    this.read = 0;
    this.write = unread;
  }
}
