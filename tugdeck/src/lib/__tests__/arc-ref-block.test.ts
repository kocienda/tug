/**
 * arc-ref-block.test.ts — the trailing block that resolves a message's arc
 * references.
 *
 * The BUILD half is read by a model, so its exact text matters: the checkout,
 * the generation, the fate, the verdict and the command that reads the arc.
 * The PARSE half is read by a replay and never refuses a line.
 */

import { describe, expect, test } from "bun:test";

import {
  ARC_REFS_MARKER,
  buildArcRefBlock,
  isArcRefBlock,
  parseArcRefBlock,
} from "@/lib/arc-ref-block";

const HEADING =
  "Arc references in this message (read one with the command shown; do not guess at what a reference means):";
const DIR = "/Users/k/src/tug";
const CREATED = "2026-11-22T14:59:33.128Z";

describe("buildArcRefBlock", () => {
  test("no entries is no block, not an empty one", () => {
    expect(buildArcRefBlock([])).toBeNull();
  });

  test("a here arc names its project, generation and fate, and reads by its generation", () => {
    const block = buildArcRefBlock([
      {
        value: "tug/gpu-wedge",
        verdict: "here",
        projectDir: DIR,
        created: CREATED,
        pinned: true,
        fate: "joined",
        joinSha: "a340619012345678",
      },
    ]);
    expect(block).toBe(
      `${ARC_REFS_MARKER}\n${HEADING}\n`
      + `- @arc:tug/gpu-wedge — project ${DIR}, created ${CREATED}, fate: joined a34061901, verdict: here — read: tugtool arc show gpu-wedge --created ${CREATED}`,
    );
  });

  test("an elsewhere arc's read carries its project", () => {
    const block = buildArcRefBlock([
      { value: "eucit/fold-rail", verdict: "elsewhere", projectDir: "/u/src/eucit", fate: "live" },
    ]);
    expect(block).toContain(
      "- @arc:eucit/fold-rail — project /u/src/eucit, fate: live, verdict: elsewhere — read: tugtool arc show fold-rail --project /u/src/eucit",
    );
  });

  test("a created the atom did not pin is said but not passed to the read", () => {
    const block = buildArcRefBlock([
      { value: "tug/a", verdict: "here", projectDir: DIR, created: CREATED, fate: "discarded" },
    ]);
    expect(block).toContain(`created ${CREATED}, fate: discarded, verdict: here — read: tugtool arc show a`);
    expect(block).not.toContain("--created");
  });

  test("absent says so plainly and offers no read", () => {
    const block = buildArcRefBlock([{ value: "tug/nope", verdict: "absent", projectDir: DIR }]);
    expect(block).toContain(
      "- @arc:tug/nope — verdict: absent — no arc of this name is recorded for that project",
    );
    expect(block).not.toContain("arc show");
  });

  test("unverified names the command that settles it", () => {
    const block = buildArcRefBlock([{ value: "tug/maybe", verdict: "unverified" }]);
    expect(block).toContain("- @arc:tug/maybe — verdict: unverified — check: tugtool arc show maybe");
  });

  test("an unverified arc with a known checkout checks in that checkout", () => {
    const block = buildArcRefBlock([{ value: "tug/maybe", verdict: "unverified", projectDir: DIR }]);
    expect(block).toContain(`check: tugtool arc show maybe --project ${DIR}`);
  });

  test("several entries are several lines, in the order given", () => {
    const block = buildArcRefBlock([
      { value: "a/one", verdict: "absent" },
      { value: "b/two", verdict: "unverified" },
    ]);
    const lines = (block ?? "").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toStartWith("- @arc:a/one");
    expect(lines[3]).toStartWith("- @arc:b/two");
  });
});

describe("parseArcRefBlock", () => {
  test("recovers value, project, created and verdict from a built block", () => {
    const block = buildArcRefBlock([
      {
        value: "tug/gpu-wedge",
        verdict: "here",
        projectDir: DIR,
        created: CREATED,
        pinned: true,
        fate: "joined",
        joinSha: "a34061901",
      },
      { value: "eucit/fold-rail", verdict: "elsewhere", projectDir: "/u/src/eu, cit", fate: "live" },
      { value: "tug/nope", verdict: "absent" },
    ]);
    expect(parseArcRefBlock(block ?? "")).toEqual([
      { value: "tug/gpu-wedge", projectDir: DIR, created: CREATED, verdict: "here" },
      { value: "eucit/fold-rail", projectDir: "/u/src/eu, cit", verdict: "elsewhere" },
    ]);
  });

  test("a text that is not the block parses to nothing", () => {
    expect(isArcRefBlock("hello")).toBe(false);
    expect(parseArcRefBlock("- @arc:tug/a — project /x, verdict: here")).toEqual([]);
  });
});
