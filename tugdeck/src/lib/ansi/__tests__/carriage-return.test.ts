import { describe, expect, test } from "bun:test";

import { applyCarriageReturns } from "../carriage-return";

describe("applyCarriageReturns", () => {
  test("text with no carriage return is returned as it is", () => {
    const text = "one\ntwo\n";
    expect(applyCarriageReturns(text)).toBe(text);
  });

  test("a redrawn line shows its latest value", () => {
    expect(applyCarriageReturns("In Progress 0m01s\rIn Progress 0m02s\rIn Progress 0m03s")).toBe(
      "In Progress 0m03s",
    );
  });

  test("a redraw replaces the whole line, shorter or longer", () => {
    expect(applyCarriageReturns("uploading 100%\rdone")).toBe("done");
    expect(applyCarriageReturns("a\rlonger")).toBe("longer");
  });

  test("only the line holding the carriage return is redrawn", () => {
    expect(applyCarriageReturns("before\n10%\r20%\nafter\n")).toBe("before\n20%\nafter\n");
  });

  test("a line whose next value has not arrived keeps the one it has", () => {
    expect(applyCarriageReturns("10%\r")).toBe("10%");
    expect(applyCarriageReturns("10%\r20%\r")).toBe("20%");
  });

  test("a CRLF line ending keeps its line", () => {
    expect(applyCarriageReturns("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  });

  test("a line of carriage returns alone is empty", () => {
    expect(applyCarriageReturns("a\n\r\r\nb")).toBe("a\n\nb");
  });

  test("streamed pieces and the settled whole read the same", () => {
    const pieces = ["step 1\n10", "%\r2", "0%\r", "30%\nstep 2\n"];
    let streamed = "";
    for (const piece of pieces) streamed += piece;
    expect(applyCarriageReturns(streamed)).toBe("step 1\n30%\nstep 2\n");
  });
});
