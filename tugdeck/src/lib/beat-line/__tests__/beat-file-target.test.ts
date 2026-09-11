/**
 * beat-file-target tests — the beat grammar splits a file-tool beat around
 * its target and refuses everything that is not one.
 */

import { describe, expect, test } from "bun:test";

import { parseBeatFileTarget } from "@/lib/beat-line/beat-file-target";

describe("parseBeatFileTarget", () => {
  test("a bare file beat splits verb / path / empty tail", () => {
    expect(parseBeatFileTarget("Editing src/lib/foo.ts")).toEqual({
      head: "Editing ",
      path: "src/lib/foo.ts",
      tail: "",
    });
  });

  test("an absolute path is recognized whole", () => {
    expect(
      parseBeatFileTarget(
        "Editing /Users/k/src/tugtool/tests/app-test/at9998-rail-title-probe.test.ts",
      ),
    ).toEqual({
      head: "Editing ",
      path: "/Users/k/src/tugtool/tests/app-test/at9998-rail-title-probe.test.ts",
      tail: "",
    });
  });

  test("the progress suffix stays in the tail", () => {
    expect(parseBeatFileTarget("Writing voice.ts — 37 lines")).toEqual({
      head: "Writing ",
      path: "voice.ts",
      tail: " — 37 lines",
    });
    expect(parseBeatFileTarget("Writing voice.ts — 1 line")).toEqual({
      head: "Writing ",
      path: "voice.ts",
      tail: " — 1 line",
    });
  });

  test("the streaming ellipsis is a suffix, not part of the path", () => {
    expect(parseBeatFileTarget("Editing tug-activity-line.css…")).toEqual({
      head: "Editing ",
      path: "tug-activity-line.css",
      tail: "…",
    });
  });

  test("a subagent label prefix rides in the head", () => {
    expect(parseBeatFileTarget("Explore · Reading tugdeck/src/main.tsx")).toEqual({
      head: "Explore · Reading ",
      path: "tugdeck/src/main.tsx",
      tail: "",
    });
  });

  test("monologue prose that opens with a verb is refused", () => {
    expect(parseBeatFileTarget("Reading the docs before the next step.")).toBeNull();
    expect(parseBeatFileTarget("Editing is done — running the tests now.")).toBeNull();
  });

  test("a pathless target is refused", () => {
    expect(parseBeatFileTarget("Reading everything")).toBeNull();
    expect(parseBeatFileTarget("Editing…")).toBeNull();
  });

  test("non-file beats are refused", () => {
    expect(parseBeatFileTarget("Running just app-test")).toBeNull();
    expect(parseBeatFileTarget("Done")).toBeNull();
    expect(parseBeatFileTarget("Compacted context (was 120k)")).toBeNull();
  });
});
