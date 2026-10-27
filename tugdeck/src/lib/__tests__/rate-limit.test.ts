/**
 * rate-limit.test.ts — pure-logic coverage for the app-level rate-limit
 * banner helpers ([#step-3.5]).
 *
 * No store, no DOM — the banner mount/dedup is covered by the real-app test;
 * this pins the trigger policy and the countdown formatter, mirroring
 * `model-label.test.ts`.
 *
 * The `status` enum is the one confirmed from the CLI v2.1.158 schema:
 * `allowed` | `allowed_warning` | `rejected`. The benign default every
 * captured payload carries is `status: "allowed"`, `overageStatus:
 * "rejected"` (org-overage-off) — which must NOT escalate.
 */

import { describe, expect, test } from "bun:test";
import type { RateLimitInfo } from "@/protocol";
import { formatResetCountdown, rateLimitBannerState,
  USAGE_BULLETIN_IDLE,
  nextUsageBulletin,
  usageLimitResetLine,
  usageLimitTitle,
} from "@/lib/rate-limit";

/** The benign default: allowed quota, overage org-disabled. */
function info(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    status: "allowed",
    resetsAt: 2_000_000_000,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    isUsingOverage: false,
    ...overrides,
  };
}

describe("rateLimitBannerState", () => {
  test("null quota is ok (no banner)", () => {
    expect(rateLimitBannerState(null)).toBe("ok");
  });

  test("the benign default is ok — overageStatus:rejected must not escalate", () => {
    // The exact payload that previously lit a red chip on a healthy session.
    expect(rateLimitBannerState(info())).toBe("ok");
  });

  test("allowed_warning is approaching", () => {
    expect(rateLimitBannerState(info({ status: "allowed_warning" }))).toBe(
      "approaching",
    );
  });

  test("rejected is limited", () => {
    expect(rateLimitBannerState(info({ status: "rejected" }))).toBe("limited");
  });

  test("overage close (isUsingOverage + overageStatus allowed_warning) is approaching", () => {
    expect(
      rateLimitBannerState(
        info({ isUsingOverage: true, overageStatus: "allowed_warning" }),
      ),
    ).toBe("approaching");
  });

  test("overage rejected alone (not using overage) stays ok", () => {
    expect(
      rateLimitBannerState(info({ isUsingOverage: false, overageStatus: "rejected" })),
    ).toBe("ok");
  });
});

describe("formatResetCountdown", () => {
  const now = 1_000_000 * 1000; // 1,000,000 s in ms

  test("more than an hour out shows Xh Ym", () => {
    expect(formatResetCountdown(1_000_000 + 5 * 3600 + 23 * 60, now)).toBe(
      "5h 23m",
    );
  });

  test("less than an hour out shows Ym", () => {
    expect(formatResetCountdown(1_000_000 + 59 * 60, now)).toBe("59m");
  });

  test("under a minute shows <1m", () => {
    expect(formatResetCountdown(1_000_000 + 30, now)).toBe("<1m");
  });

  test("a passed reset shows now", () => {
    expect(formatResetCountdown(1_000_000, now)).toBe("now");
    expect(formatResetCountdown(1_000_000 - 100, now)).toBe("now");
  });

  test("an exact hour shows Xh 0m", () => {
    expect(formatResetCountdown(1_000_000 + 2 * 3600, now)).toBe("2h 0m");
  });
});

describe("nextUsageBulletin", () => {
  const NOW = 1_000_000 * 1000;

  test("stays quiet below the first barrier", () => {
    const { state, fire } = nextUsageBulletin(USAGE_BULLETIN_IDLE, info({ utilization: 0.76 }), NOW);
    expect(fire).toBeNull();
    expect(state.fired).toEqual([]);
  });

  test("fires once per barrier, highest-new only, never repeating", () => {
    let state = USAGE_BULLETIN_IDLE;
    // Jump straight to 87%: one caution at the 85 barrier (80 absorbed).
    let r = nextUsageBulletin(state, info({ utilization: 0.87 }), NOW);
    state = r.state;
    expect(r.fire).toEqual({ tone: "caution", message: expect.stringContaining("Usage at 87%") });
    // Same window, same pct: silent.
    r = nextUsageBulletin(state, info({ utilization: 0.87 }), NOW);
    state = r.state;
    expect(r.fire).toBeNull();
    // 91%: the 90 barrier fires once.
    r = nextUsageBulletin(state, info({ utilization: 0.91 }), NOW);
    state = r.state;
    expect(r.fire).not.toBeNull();
    expect(r.fire!.message).toContain("Usage at 91%");
    r = nextUsageBulletin(state, info({ utilization: 0.93 }), NOW);
    expect(r.fire).toBeNull();
  });

  test("the 100 barrier and rejected status are danger-toned", () => {
    const full = nextUsageBulletin(USAGE_BULLETIN_IDLE, info({ utilization: 1.0 }), NOW);
    expect(full.fire).toEqual({ tone: "danger", message: expect.stringContaining("Usage limit reached") });
    const rejected = nextUsageBulletin(USAGE_BULLETIN_IDLE, info({ status: "rejected" }), NOW);
    expect(rejected.fire!.tone).toBe("danger");
  });

  test("a new reset window re-arms every barrier", () => {
    let state = USAGE_BULLETIN_IDLE;
    state = nextUsageBulletin(state, info({ utilization: 0.86 }), NOW).state;
    const rolled = nextUsageBulletin(state, info({ utilization: 0.86, resetsAt: 3_000_000 }), NOW);
    expect(rolled.fire).not.toBeNull();
  });

  test("status fallback arms 90 on allowed_warning when utilization is absent", () => {
    const r = nextUsageBulletin(USAGE_BULLETIN_IDLE, info({ status: "allowed_warning" }), NOW);
    expect(r.fire).toEqual({ tone: "caution", message: expect.stringContaining("Usage at 90%") });
  });
});

describe("usageLimitTitle", () => {
  test("names the window the turn was refused against", () => {
    expect(usageLimitTitle("five_hour")).toBe("Session limit reached");
    expect(usageLimitTitle("seven_day")).toBe("Weekly limit reached");
    expect(usageLimitTitle("seven_day_opus")).toBe("Weekly Opus limit reached");
    expect(usageLimitTitle(undefined)).toBe("Usage limit reached");
    expect(usageLimitTitle("something_new")).toBe("Usage limit reached");
  });
});

describe("usageLimitResetLine", () => {
  const TZ = "America/Los_Angeles";
  // 2026-10-27 04:10 UTC = 9:10 PM Oct 26 in Los Angeles.
  const RESETS = Date.UTC(2026, 9, 27, 4, 10) / 1000;

  test("a reset later the same day reads 'today'", () => {
    const now = Date.UTC(2026, 9, 27, 2, 53); // 7:53 PM local
    expect(usageLimitResetLine(RESETS, now, "en-US", TZ)).toBe(
      "Resets at 9:10 PM today",
    );
  });

  test("a reset on the next day reads 'tomorrow'", () => {
    const now = Date.UTC(2026, 9, 26, 4, 0); // 9:00 PM Oct 25 local
    expect(usageLimitResetLine(RESETS, now, "en-US", TZ)).toBe(
      "Resets at 9:10 PM tomorrow",
    );
  });

  test("a reset further out names its day", () => {
    const now = Date.UTC(2026, 9, 24, 18, 0);
    expect(usageLimitResetLine(RESETS, now, "en-US", TZ)).toBe(
      "Resets at 9:10 PM on Mon, Oct 26",
    );
  });

  test("a reset already past reads in the past tense", () => {
    const now = Date.UTC(2026, 9, 27, 18, 0);
    expect(usageLimitResetLine(RESETS, now, "en-US", TZ)).toBe(
      "Reset at 9:10 PM on Mon, Oct 26",
    );
  });

  test("no reset time is no line", () => {
    expect(usageLimitResetLine(undefined, 0)).toBeNull();
    expect(usageLimitResetLine(0, 0)).toBeNull();
  });
});
