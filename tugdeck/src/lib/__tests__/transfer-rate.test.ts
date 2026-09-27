/**
 * transfer-rate — the arithmetic behind a transfer's detail line.
 *
 * Every assertion here is about a case that would otherwise show a user a
 * number that is wrong rather than merely imprecise: a rate computed across
 * a zero-width interval, a rate carried over from a transfer that restarted,
 * a line that claims a total nobody has reported.
 */

import { describe, expect, test } from "bun:test";

import {
  formatBytes,
  formatRate,
  formatRemaining,
  newRateEstimator,
  transferDetailLine,
} from "../transfer-rate";

describe("formatBytes", () => {
  test("decimal units, and a width that barely moves", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(12_400_000)).toBe("12.4 MB");
    expect(formatBytes(48_100_000)).toBe("48.1 MB");
    // One decimal below 100, none above — "124 MB" rather than "123.5 MB", so
    // the digit count stops growing exactly where the precision stops being
    // worth its width.
    expect(formatBytes(123_500_000)).toBe("124 MB");
    expect(formatBytes(3_000_000_000)).toBe("3.0 GB");
  });

  test("nonsense reads as nothing rather than as NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("formatRemaining", () => {
  test("coarse, and hedged, because the estimate is", () => {
    expect(formatRemaining(3)).toBe("a few seconds left");
    expect(formatRemaining(32)).toBe("about 30 s left");
    expect(formatRemaining(103)).toBe("about 2 min left");
    expect(formatRemaining(3599)).toBe("about 60 min left");
    expect(formatRemaining(7200)).toContain("h left");
  });

  test("a sub-minute answer never rounds to zero", () => {
    // "about 0 s left" on a transfer still running would be a lie the user
    // would catch within the second.
    expect(formatRemaining(11)).toBe("about 10 s left");
    expect(formatRemaining(59)).toBe("about 60 s left");
  });
});

describe("the rate estimator", () => {
  test("says nothing until two usable samples have arrived", () => {
    const one = newRateEstimator().sample(1000, 0);
    expect(one.bytesPerSecond).toBeNull();
  });

  test("a first interval is taken at face value, then smoothed", () => {
    const e = newRateEstimator().sample(0, 0).sample(1_000_000, 1000);
    expect(e.bytesPerSecond).toBe(1_000_000);

    // A doubled instantaneous rate moves the estimate part of the way, not
    // all of it — one fast sample is not a new rate.
    const faster = e.sample(3_000_000, 2000);
    expect(faster.bytesPerSecond).toBeGreaterThan(1_000_000);
    expect(faster.bytesPerSecond).toBeLessThan(2_000_000);
  });

  test("two readings in the same instant do not divide by nothing", () => {
    const e = newRateEstimator().sample(0, 0).sample(1_000_000, 1000);
    const same = e.sample(1_000_005, 1001);
    // The sample is discarded rather than reported as gigabytes per second.
    expect(same.bytesPerSecond).toBe(1_000_000);
  });

  test("a count that went backwards re-anchors rather than going negative", () => {
    // A restart, or a resume that began again from zero. A negative rate
    // would print a negative ETA.
    const e = newRateEstimator().sample(0, 0).sample(5_000_000, 1000);
    const restarted = e.sample(0, 2000);
    expect(restarted.bytesPerSecond).toBeNull();
    expect(restarted.sample(1_000_000, 3000).bytesPerSecond).toBe(1_000_000);
  });

  test("the estimator is a value — sampling one does not change it", () => {
    const e = newRateEstimator().sample(0, 0).sample(1_000_000, 1000);
    e.sample(9_000_000, 2000);
    expect(e.bytesPerSecond).toBe(1_000_000);
  });
});

describe("transferDetailLine", () => {
  test("a total nobody reported is Starting…, never a false 0", () => {
    expect(transferDetailLine(0, 0, null)).toBe("Starting…");
    expect(transferDetailLine(512_000, 0, 100_000)).toBe("Starting…");
  });

  test("bytes alone until a rate is measured", () => {
    expect(transferDetailLine(12_400_000, 48_100_000, null)).toBe(
      "12.4 MB of 48.1 MB",
    );
  });

  test("bytes, rate and time once all three are known", () => {
    expect(transferDetailLine(12_400_000, 48_100_000, 1_200_000)).toBe(
      "12.4 MB of 48.1 MB · 1.2 MB/s · about 30 s left",
    );
  });

  test("a zero rate contributes no ETA", () => {
    // Dividing by it would print Infinity.
    expect(transferDetailLine(1000, 48_100_000, 0)).toBe("1.0 kB of 48.1 MB");
  });

  test("formatRate reads as a rate", () => {
    expect(formatRate(1_200_000)).toBe("1.2 MB/s");
  });
});

describe("transferDetailLine: the trailing clause ([B05])", () => {
  test("the warning joins after an em dash rather than as another term", () => {
    expect(
      transferDetailLine(12_400_000, 48_100_000, null, "stopping discards it"),
    ).toBe("12.4 MB of 48.1 MB — stopping discards it");
  });

  test("the ETA is what a line too long sheds, never the warning", () => {
    // All three facts plus the clause runs past what one row of the 560px
    // panel can show, and a wrapped row would move every row under it. The
    // ETA goes because the bar and the byte count between them imply it; the
    // warning stays because nothing else in the panel says it.
    expect(
      transferDetailLine(
        12_400_000,
        48_100_000,
        1_200_000,
        "stopping discards it",
      ),
    ).toBe("12.4 MB of 48.1 MB · 1.2 MB/s — stopping discards it");
  });

  test("a line with no warning keeps its ETA", () => {
    expect(transferDetailLine(12_400_000, 48_100_000, 1_200_000)).toBe(
      "12.4 MB of 48.1 MB · 1.2 MB/s · about 30 s left",
    );
  });

  test("the budget reaches only the line it was measured on", () => {
    // The 58-character budget is the UpdateTug download row's 352px column
    // with *Stop for Now* beside it. ConfigureTug paints its own download line
    // through this same function, in a different row of a different panel, and
    // passes no trailer — so the shed must not reach it. The widest a
    // trailerless line gets is the three longest clauses this function can
    // format, and every one of them keeps its ETA.
    const widest = transferDetailLine(999_900_000, 999_900_000_000, 999_900_000);
    expect(widest.length).toBeGreaterThan(48);
    expect(widest).toContain("left");
  });

  test("the warning survives a total nobody has reported yet", () => {
    expect(transferDetailLine(0, 0, null, "stopping starts it over")).toBe(
      "Starting… — stopping starts it over",
    );
  });
});
