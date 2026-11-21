import { describe, expect, test } from "bun:test";

import { formatElapsed, quietQuestion, runLivenessText } from "../run-liveness";

describe("formatElapsed", () => {
  test("seconds, then minutes and seconds, then hours and minutes", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(8_400)).toBe("8s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(65_000)).toBe("1m05s");
    expect(formatElapsed(3_599_000)).toBe("59m59s");
    expect(formatElapsed(3_725_000)).toBe("1h02m");
  });

  test("a clock that reads behind the start says zero", () => {
    expect(formatElapsed(-250)).toBe("0s");
  });
});

describe("runLivenessText", () => {
  test("a command that has printed says how long ago", () => {
    expect(runLivenessText(1_000, 54_000, 66_000)).toEqual({
      elapsed: "1m05s",
      lastOutput: "last output 12s ago",
    });
  });

  test("a command that has printed nothing says so", () => {
    expect(runLivenessText(1_000, null, 4_000)).toEqual({
      elapsed: "3s",
      lastOutput: "no output yet",
    });
  });
});

describe("quietQuestion", () => {
  test("the silence is read from the frame, in whole minutes from a minute on", () => {
    expect(quietQuestion(120_000)).toBe("No output for 2 minutes. This command might be stuck.");
    expect(quietQuestion(240_000)).toBe("No output for 4 minutes. This command might be stuck.");
    expect(quietQuestion(60_000)).toBe("No output for 1 minute. This command might be stuck.");
    // Two minutes, a 37-second pause before Keep Waiting, then four more.
    expect(quietQuestion(397_000)).toBe("No output for 6 minutes. This command might be stuck.");
    expect(quietQuestion(90_000)).toBe("No output for 1 minute. This command might be stuck.");
  });

  test("a silence under a minute is said in seconds, and never as none", () => {
    expect(quietQuestion(45_000)).toBe("No output for 45 seconds. This command might be stuck.");
    expect(quietQuestion(1_000)).toBe("No output for 1 second. This command might be stuck.");
    expect(quietQuestion(300)).toBe("No output for 1 second. This command might be stuck.");
  });
});
