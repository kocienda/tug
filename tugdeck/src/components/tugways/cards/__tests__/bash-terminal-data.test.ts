/**
 * `composeTerminalData` — the Bash block's one composer strips the
 * `TUG-CHART:` lines out of stdout and carries them beside it, so the body
 * and the search index read the same terminal text; stderr is untouched.
 */

import { describe, expect, test } from "bun:test";

import { composeTerminalData } from "@/components/tugways/cards/blocks/bash-tool-block";

const SPEC = '{"tugchart":1,"form":"sparkline","values":[1,2,3]}';

describe("composeTerminalData", () => {
  test("strips chart lines from stdout and keeps them in order", () => {
    const data = composeTerminalData(
      { stdout: `one\nTUG-CHART: ${SPEC}\ntwo\n`, stderr: `TUG-CHART: ${SPEC}\nwarn` },
      undefined,
      false,
    );
    expect(data.stdout).toBe("one\ntwo\n");
    expect(data.charts).toEqual([SPEC]);
    expect(data.chartsDropped).toBe(0);
    expect(data.stderr, "stderr is not a chart door").toBe(`TUG-CHART: ${SPEC}\nwarn`);
    expect(data.exitCode).toBe(0);
  });

  test("the text fallback is stripped the same way", () => {
    const data = composeTerminalData(undefined, `TUG-CHART: ${SPEC}\nonly text`, true);
    expect(data.stdout).toBe("only text");
    expect(data.charts).toEqual([SPEC]);
    expect(data.exitCode).toBe(1);
  });

  test("no chart line: nothing changes", () => {
    const data = composeTerminalData({ stdout: "a\nb", stderr: "" }, undefined, false);
    expect(data.stdout).toBe("a\nb");
    expect(data.charts).toEqual([]);
    expect(data.chartsDropped).toBe(0);
  });
});
