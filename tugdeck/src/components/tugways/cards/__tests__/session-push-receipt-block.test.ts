import { describe, expect, it } from "bun:test";

import {
  matchesPushReceipt,
  parsePushReceipt,
} from "@/components/tugways/cards/session-push-receipt-block";

describe("matchesPushReceipt", () => {
  it("claims /push and /push <args>, not /pushx or a bare git", () => {
    expect(matchesPushReceipt("/push")).toBe(true);
    expect(matchesPushReceipt("/push origin main")).toBe(true);
    expect(matchesPushReceipt("/pushx")).toBe(false);
    expect(matchesPushReceipt("git push")).toBe(false);
    expect(matchesPushReceipt("push")).toBe(false);
  });
});

describe("parsePushReceipt", () => {
  // The string this asserts against is `format_push_summary`'s, spelled out
  // rather than built from a shared constant — the point is that the two sides
  // agree on the *bytes*, and a fixture derived from either one could not show
  // that. `·` is U+00B7 and `→` U+2192.
  it("round-trips a format_push_summary-shaped string", () => {
    const out =
      "pushed main → origin/main · 2 commit(s) · 1111111111..2222222222\n" +
      "newest\n" +
      "older";
    expect(parsePushReceipt(out)).toEqual({
      branch: "main",
      upstream: "origin/main",
      commits: 2,
      before: "1111111111",
      after: "2222222222",
      subjects: ["newest", "older"],
    });
  });

  it("parses a (new) push, whose summary is the header alone", () => {
    const out = "pushed feature → origin/feature · 4 commit(s) · (new)..3333333333";
    expect(parsePushReceipt(out)).toEqual({
      branch: "feature",
      upstream: "origin/feature",
      commits: 4,
      before: "(new)",
      after: "3333333333",
      subjects: [],
    });
  });

  it("returns null on a /commit summary", () => {
    const out =
      "committed 0123456789 · 2 file(s) · +14 −2\n" +
      'files: [{"path":"src/a.rs","status":"modified","added":10,"removed":2}]\n' +
      "Fix the thing";
    expect(parsePushReceipt(out)).toBeNull();
  });

  it("returns null on a header that only looks right", () => {
    // An ASCII middot and a hyphen-arrow are what a hand-typed line carries,
    // and neither must parse — the header is a machine format.
    expect(
      parsePushReceipt("pushed main -> origin/main · 1 commit(s) · aaaa..bbbb"),
    ).toBeNull();
    expect(
      parsePushReceipt("pushed main → origin/main . 1 commit(s) . aaaa..bbbb"),
    ).toBeNull();
    expect(parsePushReceipt("")).toBeNull();
  });
});
