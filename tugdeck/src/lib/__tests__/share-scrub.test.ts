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
