/**
 * `FramePeeler` — reassembly across chunk boundaries, the oversized-length
 * reset, and the copy budget that is the reason it exists: no frame re-copies
 * the bytes behind it.
 */

import { describe, expect, test } from "bun:test";
import { FramePeeler } from "../frame-peeler";
import { HEADER_SIZE, MAX_PAYLOAD_SIZE, encodeFrame } from "@/protocol";

function frame(feedId: number, text: string): Uint8Array {
  return new Uint8Array(encodeFrame({ feedId: feedId as 0x40, flags: 0, payload: new TextEncoder().encode(text) }));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const text = (payload: ArrayBuffer): string => new TextDecoder().decode(payload);

describe("FramePeeler", () => {
  test("one frame split across three chunks arrives once, whole", () => {
    const peeler = new FramePeeler();
    const bytes = frame(0x40, "hello, split world");
    expect(peeler.push(bytes.subarray(0, 3))).toEqual([]);
    expect(peeler.push(bytes.subarray(3, 10))).toEqual([]);
    const out = peeler.push(bytes.subarray(10));
    expect(out.length).toBe(1);
    expect(out[0]!.feedId).toBe(0x40);
    expect(text(out[0]!.payload)).toBe("hello, split world");
    expect(peeler.pending).toBe(0);
  });

  test("five frames in one chunk arrive in order", () => {
    const peeler = new FramePeeler();
    const parts = ["a", "bb", "ccc", "dddd", "eeeee"].map((t, i) => frame(0x10 + i, t));
    const out = peeler.push(concat(parts));
    expect(out.map((f) => f.feedId)).toEqual([0x10, 0x11, 0x12, 0x13, 0x14]);
    expect(out.map((f) => text(f.payload))).toEqual(["a", "bb", "ccc", "dddd", "eeeee"]);
  });

  test("a partial header waits for the rest", () => {
    const peeler = new FramePeeler();
    const bytes = frame(0x52, "{}");
    expect(peeler.push(bytes.subarray(0, HEADER_SIZE - 2))).toEqual([]);
    expect(peeler.pending).toBe(HEADER_SIZE - 2);
    const out = peeler.push(bytes.subarray(HEADER_SIZE - 2));
    expect(out.map((f) => text(f.payload))).toEqual(["{}"]);
  });

  test("an oversized length resets the buffer and reports it", () => {
    const reported: number[] = [];
    const peeler = new FramePeeler((length) => reported.push(length));
    const header = new Uint8Array(HEADER_SIZE);
    new DataView(header.buffer).setUint32(2, MAX_PAYLOAD_SIZE + 1, false);
    expect(peeler.push(header)).toEqual([]);
    expect(reported).toEqual([MAX_PAYLOAD_SIZE + 1]);
    expect(peeler.pending).toBe(0);
    // The next legitimate frame arrives clean.
    expect(peeler.push(frame(0x40, "ok")).map((f) => text(f.payload))).toEqual(["ok"]);
  });

  test("each payload is its own buffer, so it can be transferred", () => {
    const peeler = new FramePeeler();
    const out = peeler.push(concat([frame(0x40, "one"), frame(0x40, "two")]));
    expect(out[0]!.payload).not.toBe(out[1]!.payload);
    expect(out[0]!.payload.byteLength).toBe(3);
  });

  test("10,000 small frames copy each byte in once and out once, plus bounded compaction", () => {
    const peeler = new FramePeeler(() => {}, 1024);
    const one = frame(0x40, "x".repeat(25));
    const payloadBytes = 25;
    let delivered = 0;
    // Chunk boundaries that never line up with frame boundaries, so a tail
    // is always left behind.
    const stream = concat(Array.from({ length: 10_000 }, () => one));
    for (let at = 0; at < stream.length; at += 97) {
      delivered += peeler.push(stream.subarray(at, Math.min(stream.length, at + 97))).length;
    }
    expect(delivered).toBe(10_000);
    expect(peeler.copies.inBytes).toBe(stream.length);
    expect(peeler.copies.outBytes).toBe(10_000 * payloadBytes);
    // The tail is moved only when the read offset passes half the capacity,
    // and what moves is under one frame: far below the stream's size, where
    // a re-slice per frame would copy the remaining buffer every time.
    expect(peeler.copies.compactBytes).toBeLessThan(peeler.copies.compactions * one.length + 1);
    expect(peeler.copies.compactBytes).toBeLessThan(stream.length / 10);
  });
});
