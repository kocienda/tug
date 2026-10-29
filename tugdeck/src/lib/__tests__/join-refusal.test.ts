import { describe, expect, test } from "bun:test";

import { parseJoinRefusal } from "@/lib/join-refusal";

describe("parseJoinRefusal", () => {
  test("a resolver refusal naming paths becomes a sentence and rows", () => {
    expect(
      parseJoinRefusal("the resolver's report does not account for src/a.rs, docs/b.md"),
    ).toEqual({
      sentence: "the resolver's report does not account for 2 files",
      paths: ["src/a.rs", "docs/b.md"],
    });
    expect(
      parseJoinRefusal("the resolver rewrote lines outside the conflicts in src/a.rs"),
    ).toEqual({
      sentence: "the resolver rewrote lines outside the conflicts in 1 file",
      paths: ["src/a.rs"],
    });
    expect(
      parseJoinRefusal("the resolver changed Justfile, x.ts without accounting for it"),
    ).toEqual({
      sentence: "the resolver changed 2 files without accounting for it",
      paths: ["Justfile", "x.ts"],
    });
  });

  test("a sentence ending on words, not paths, stays whole", () => {
    const prose = "the resolver is waiting on an unanswered question: where does the gate run?";
    expect(parseJoinRefusal(prose)).toEqual({ sentence: prose, paths: [] });
    const words = "the resolver left conflicts in the open";
    expect(parseJoinRefusal(words)).toEqual({ sentence: words, paths: [] });
  });

  test("a legacy check sentence yields its selection as rows and its head as the sentence", () => {
    expect(
      parseJoinRefusal(
        "the candidate failed its checks: deck: `just app-test-changed 'tugdeck/src/a.tsx' 'tests/app-test/it'\\''s.test.ts'` (exit 1) · first red at0001 > opens",
      ),
    ).toEqual({
      sentence:
        "the candidate failed its checks: deck ran `just app-test-changed`, exit 1, first red at0001 > opens",
      paths: ["tugdeck/src/a.tsx", "tests/app-test/it's.test.ts"],
    });
  });

  test("a legacy check sentence with no selection keeps its command whole", () => {
    expect(parseJoinRefusal("the candidate failed its checks: docs: `false` (exit 1)")).toEqual({
      sentence: "the candidate failed its checks: docs ran `false`, exit 1",
      paths: [],
    });
  });

  test("an unrecognised string is its own sentence", () => {
    expect(parseJoinRefusal("the resolver exited")).toEqual({
      sentence: "the resolver exited",
      paths: [],
    });
  });
});
