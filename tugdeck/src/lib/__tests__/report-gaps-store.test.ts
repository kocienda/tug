import { describe, expect, test } from "bun:test";

import { narrowSessionGaps } from "../report-gaps-store";

describe("report gaps — a session's dark calls", () => {
  test("the route's rows are read as they came, and a malformed row is dropped", () => {
    expect(
      narrowSessionGaps({
        status: "ok",
        gaps: [
          { head: "cargo nextest", wallMs: 95_000, endedAtMs: 2_000 },
          { head: "", wallMs: 30_000, endedAtMs: 1_500 },
          { head: "just build-app", wallMs: "long", endedAtMs: 1_000 },
          { head: "just app-test", wallMs: 40_000, endedAtMs: 900 },
        ],
      }),
    ).toEqual([
      { head: "cargo nextest", wallMs: 95_000, endedAtMs: 2_000 },
      { head: "just app-test", wallMs: 40_000, endedAtMs: 900 },
    ]);
  });

  test("an answer with no list is no dark calls", () => {
    expect(narrowSessionGaps({ status: "error", message: "forbidden" })).toEqual([]);
    expect(narrowSessionGaps(null)).toEqual([]);
  });
});
