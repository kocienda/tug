/**
 * Pin the idea reference block: one line per entry in the shape the plugin's
 * `arc-references.md` teaches, `null` for none, and a parse that recovers the
 * identity a replay puts back on the atom.
 */

import { describe, expect, test } from "bun:test";

import {
  IDEA_REFS_MARKER,
  buildIdeaRefBlock,
  isIdeaRefBlock,
  parseIdeaRefBlock,
} from "@/lib/idea-ref-block";

describe("idea reference block", () => {
  test("no entries is no block", () => {
    expect(buildIdeaRefBlock([])).toBeNull();
  });

  test("each verdict says itself in the taught shape", () => {
    const block = buildIdeaRefBlock([
      {
        value: "1a2b3c4d",
        verdict: "here",
        text: "An inbox for ideas",
        projectDir: "/u/src/tug",
        docket: "Inbox",
        sketch: "3f9a1c2e",
      },
      { value: "9e8d7c6b", verdict: "elsewhere", text: "Fold the rail", projectDir: "/u/src/eucit" },
      { value: "00ff00ff", verdict: "absent" },
      { value: "12ab34cd", verdict: "unverified" },
    ]);
    expect(block).toBe(
      [
        IDEA_REFS_MARKER,
        "Idea references in this message (read one with the command shown; do not guess at what a reference means):",
        '- @idea:1a2b3c4d — "An inbox for ideas", project /u/src/tug, docket Inbox, sketch 3f9a1c2e, verdict: here — read: tugtool idea show 1a2b3c4d',
        '- @idea:9e8d7c6b — "Fold the rail", project /u/src/eucit, docket none, sketch none, verdict: elsewhere — read: tugtool idea show 9e8d7c6b',
        "- @idea:00ff00ff — verdict: absent — this idea is not on this machine",
        "- @idea:12ab34cd — verdict: unverified — check: tugtool idea show 12ab34cd",
      ].join("\n"),
    );
  });

  test("a quote inside the line cannot end the quotes early", () => {
    const block = buildIdeaRefBlock([
      { value: "1a2b3c4d", verdict: "here", text: 'Say "hi"', projectDir: "/r" },
    ]);
    expect(block).toContain(`"Say 'hi'"`);
  });

  test("the parse recovers each identified line and skips the rest", () => {
    const block = buildIdeaRefBlock([
      {
        value: "1a2b3c4d",
        verdict: "here",
        text: "An inbox, with commas",
        projectDir: "/u/src/my, odd dir",
        docket: "Inbox, mine",
        sketch: "3f9a1c2e",
      },
      { value: "00ff00ff", verdict: "absent" },
    ])!;
    expect(isIdeaRefBlock(block)).toBe(true);
    expect(parseIdeaRefBlock(block)).toEqual([
      {
        value: "1a2b3c4d",
        text: "An inbox, with commas",
        projectDir: "/u/src/my, odd dir",
        verdict: "here",
      },
    ]);
    expect(parseIdeaRefBlock("not a block")).toEqual([]);
  });
});
