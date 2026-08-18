/**
 * `formatDashAge` — a table, with no clock to mock, because the function takes
 * `now` rather than reading it.
 *
 * The cases worth pinning are the ones where "show nothing" is the right answer
 * and a plausible implementation would show something wrong instead: an absent
 * timestamp, one that does not parse, and one in the FUTURE. A future instant
 * means a clock skew somewhere, and clamping it to `now` would be a confident
 * lie about when somebody last worked on the dash.
 */

import { describe, expect, test } from "bun:test";

import { formatDashAge } from "../dash-age";

const NOW = Date.parse("2026-08-17T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDashAge — nothing honest to say", () => {
  test("no timestamp", () => {
    expect(formatDashAge(null, NOW)).toBeNull();
  });

  test("an unparseable timestamp", () => {
    expect(formatDashAge("last tuesday", NOW)).toBeNull();
    expect(formatDashAge("", NOW)).toBeNull();
  });

  test("a future timestamp shows nothing rather than a confident `now`", () => {
    expect(formatDashAge(ago(-HOUR), NOW)).toBeNull();
    expect(formatDashAge(ago(-SECOND), NOW)).toBeNull();
  });
});

describe("formatDashAge — the units", () => {
  test("under a minute reads `now`", () => {
    expect(formatDashAge(ago(0), NOW)).toBe("now");
    expect(formatDashAge(ago(59 * SECOND), NOW)).toBe("now");
  });

  test("minutes", () => {
    expect(formatDashAge(ago(MINUTE), NOW)).toBe("1m");
    expect(formatDashAge(ago(59 * MINUTE), NOW)).toBe("59m");
  });

  test("hours", () => {
    expect(formatDashAge(ago(HOUR), NOW)).toBe("1h");
    expect(formatDashAge(ago(23 * HOUR), NOW)).toBe("23h");
  });

  test("days, unbounded", () => {
    expect(formatDashAge(ago(DAY), NOW)).toBe("1d");
    expect(formatDashAge(ago(3 * DAY), NOW)).toBe("3d");
    expect(formatDashAge(ago(400 * DAY), NOW)).toBe("400d");
  });

  // Each boundary is exclusive below and inclusive above, so no elapsed time
  // falls through into a unit it does not belong to.
  test("the boundaries land on the coarser unit", () => {
    expect(formatDashAge(ago(MINUTE - 1), NOW)).toBe("now");
    expect(formatDashAge(ago(HOUR - 1), NOW)).toBe("59m");
    expect(formatDashAge(ago(DAY - 1), NOW)).toBe("23h");
  });

  test("truncates rather than rounds — an age never reads ahead of itself", () => {
    expect(formatDashAge(ago(HOUR + 59 * MINUTE), NOW)).toBe("1h");
    expect(formatDashAge(ago(DAY + 23 * HOUR), NOW)).toBe("1d");
  });
});
