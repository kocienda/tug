/**
 * The `scrub_share_text` wire as the deck reads and writes it: the request
 * frame's shape, and the decoders that refuse an answer which would put a
 * string in the wrong place of a share output.
 */

import { describe, expect, test } from "bun:test";

import {
  decodeScrubShareTextErr,
  decodeScrubShareTextOk,
  encodeScrubShareText,
} from "@/protocol";
import { batchScrubTexts } from "@/lib/share-scrub";

describe("scrub_share_text", () => {
  test("the request carries the id and the strings in order", () => {
    const frame = encodeScrubShareText({ requestId: "scrub-3", texts: ["a", "b"] });
    expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual({
      action: "scrub_share_text",
      request_id: "scrub-3",
      texts: ["a", "b"],
    });
  });

  test("an ok answer of the S01 shape decodes", () => {
    expect(
      decodeScrubShareTextOk({
        action: "scrub_share_text_ok",
        request_id: "scrub-3",
        texts: ["[secret]", "~/x"],
      }),
    ).toEqual({ requestId: "scrub-3", texts: ["[secret]", "~/x"] });
    expect(
      decodeScrubShareTextOk({ action: "scrub_share_text_ok", request_id: "r", texts: [] }),
    ).toEqual({ requestId: "r", texts: [] });
  });

  test("an ok answer with a non-array texts is refused", () => {
    expect(
      decodeScrubShareTextOk({ action: "scrub_share_text_ok", request_id: "r", texts: "x" }),
    ).toBeNull();
    expect(
      decodeScrubShareTextOk({ action: "scrub_share_text_ok", request_id: "r", texts: ["a", 1] }),
    ).toBeNull();
  });

  test("an ok answer with no request id is refused", () => {
    expect(decodeScrubShareTextOk({ action: "scrub_share_text_ok", texts: ["a"] })).toBeNull();
    expect(
      decodeScrubShareTextOk({ action: "scrub_share_text_ok", request_id: "", texts: ["a"] }),
    ).toBeNull();
  });

  test("another action is not an ok answer", () => {
    expect(
      decodeScrubShareTextOk({ action: "scrub_share_text_err", request_id: "r", texts: [] }),
    ).toBeNull();
    expect(decodeScrubShareTextOk(null)).toBeNull();
  });

  test("an err answer decodes its reason, with or without an id", () => {
    expect(
      decodeScrubShareTextErr({
        action: "scrub_share_text_err",
        request_id: "r",
        reason: "too_large",
      }),
    ).toEqual({ requestId: "r", reason: "too_large" });
    expect(
      decodeScrubShareTextErr({
        action: "scrub_share_text_err",
        request_id: null,
        reason: "malformed_request",
      }),
    ).toEqual({ requestId: null, reason: "malformed_request" });
  });
});

describe("batchScrubTexts", () => {
  const joined = (batches: ReturnType<typeof batchScrubTexts>, count: number): string[] => {
    const out = Array.from({ length: count }, () => "");
    for (const batch of batches) for (const piece of batch) out[piece.index] += piece.text;
    return out;
  };

  test("short strings share one batch, and an empty string keeps its place", () => {
    const texts = ["a", "", "bc"];
    const batches = batchScrubTexts(texts, 100);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((p) => p.index)).toEqual([0, 1, 2]);
    expect(joined(batches, 3)).toEqual(texts);
  });

  test("no batch runs past the limit, and the pieces rejoin to the inputs", () => {
    const texts = ["x".repeat(40), "line one\nline two\nline three\n".repeat(20), "tail"];
    const batches = batchScrubTexts(texts, 64);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(64);
    }
    expect(joined(batches, 3)).toEqual(texts);
  });

  test("a long string is cut after a line end, so no line is split", () => {
    const text = "secret-token-aaaaaaaa\n".repeat(10);
    const batches = batchScrubTexts([text], 50);
    for (const batch of batches) for (const piece of batch) expect(piece.text.endsWith("\n")).toBe(true);
    expect(joined(batches, 1)).toEqual([text]);
  });

  test("a hard cut never splits a surrogate pair", () => {
    const text = "ab" + "😀".repeat(10);
    const batches = batchScrubTexts([text], 5);
    for (const batch of batches) {
      for (const piece of batch) {
        const last = piece.text.charCodeAt(piece.text.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
    expect(joined(batches, 1)).toEqual([text]);
  });
});
