/**
 * The page's record of tugcast's renders: how two emissions merge, what a
 * row draws for each `.rendered` state, and the text hash a finalized record
 * is proven current by.
 */

import { describe, expect, test } from "bun:test";
import type { RenderedMessageWire } from "@tugproto/rendered";
import { chooseRenderedBlocks, mergeRenderedMessage, renderedPathFor } from "../rendered-record";
import { textHash } from "@/lib/ingest/text-hash";

function block(hash: string, start: number, end: number) {
  return { hash, kind: "paragraph", startChar: start, endChar: end, depth: 0, itemCount: 0, rowCount: 0 };
}

function emission(blocks: string[], html: Record<string, string>): RenderedMessageWire {
  return {
    messageKey: "m1-b1",
    channel: "text",
    blocks: blocks.map((h, i) => block(h, i * 10, i * 10 + 10)),
    html,
    textLength: blocks.length * 10,
    textHash: "1",
  };
}

/** FNV-1a 64 by the book, in `BigInt`, as the reference the limb version must equal. */
function fnvReference(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString();
}

describe("mergeRenderedMessage", () => {
  test("keeps the latest HTML per hash and drops HTML for blocks no longer listed", () => {
    const first = emission(["1", "2"], { "1": "<p>one</p>", "2": "<p>tw</p>" });
    const second = emission(["1", "3"], { "3": "<p>two</p>" });
    const merged = mergeRenderedMessage(first, second);
    expect(merged.blocks.map((b) => b.hash)).toEqual(["1", "3"]);
    expect(merged.html).toEqual({ "1": "<p>one</p>", "3": "<p>two</p>" });

    const third = emission(["1", "3"], { "1": "<p>ONE</p>" });
    expect(mergeRenderedMessage(merged, third).html).toEqual({ "1": "<p>ONE</p>", "3": "<p>two</p>" });
  });

  test("with nothing earlier, the emission is the record", () => {
    const only = emission(["1"], { "1": "<p>x</p>" });
    expect(mergeRenderedMessage(null, only)).toBe(only);
  });
});

describe("chooseRenderedBlocks", () => {
  const whole = emission(["7", "18446744073709551557"], { "7": "<p>a</p>", "18446744073709551557": "<p>b</p>" });

  test("absent and null parse", () => {
    expect(chooseRenderedBlocks(undefined)).toBeNull();
    expect(chooseRenderedBlocks(null)).toBeNull();
  });

  test("pending keeps the DOM as it is", () => {
    expect(chooseRenderedBlocks({ pending: true })).toBe("keep");
  });

  test("a record missing a block's HTML parses", () => {
    const partial = emission(["7", "8"], { "7": "<p>a</p>" });
    expect(chooseRenderedBlocks({ streaming: true, current: false, message: partial })).toBeNull();
  });

  test("a finalized record draws when it is current and waits when it is not", () => {
    // The engine's finisher turns a wait that lasts into a `null`.
    expect(chooseRenderedBlocks({ streaming: false, current: false, message: whole })).toBe("keep");
    expect(chooseRenderedBlocks({ streaming: false, current: true, message: whole })).not.toBeNull();
  });

  test("a streaming record draws even when it is not current", () => {
    const blocks = chooseRenderedBlocks({ streaming: true, current: false, message: whole });
    if (blocks === null || blocks === "keep") throw new Error("expected blocks");
    expect(blocks.map((b) => b.html)).toEqual(["<p>a</p>", "<p>b</p>"]);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    // The full 64 bits survive into the reconciler's hash.
    expect(blocks[1]!.contentHash).toBe(18446744073709551557n);
    expect(blocks[1]!.startChar).toBe(10);
  });
});

describe("textHash", () => {
  test("equals FNV-1a 64 over UTF-8 for ASCII, multibyte and astral text", () => {
    for (const text of ["", "a", "Hello, world.", "naïve café", "日本語のテキスト", "emoji 🎉 and 𝔘𝔫𝔦", "x".repeat(5000)]) {
      expect(textHash(text)).toBe(fnvReference(text));
    }
  });

  test("the empty text is the offset basis", () => {
    expect(textHash("")).toBe("14695981039346656037");
  });
});

describe("renderedPathFor", () => {
  test("names the sibling of a Message's text path and nothing else", () => {
    expect(renderedPathFor("turn.t1.message.m1-b1.text")).toBe("turn.t1.message.m1-b1.rendered");
    expect(renderedPathFor("text")).toBeNull();
    expect(renderedPathFor("turn.t1.text")).toBeNull();
    expect(renderedPathFor("turn.t1.message.m1-b1.usage")).toBeNull();
  });
});
