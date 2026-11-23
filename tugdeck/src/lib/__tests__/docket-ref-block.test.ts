/**
 * docket-ref-block.test.ts — the trailing block that resolves a message's
 * docket references: each verdict's line for the model, and a parse that
 * recovers the owning checkout and the name for a replay.
 */

import { describe, expect, test } from "bun:test";

import {
  DOCKET_REFS_MARKER,
  buildDocketRefBlock,
  isDocketRefBlock,
  parseDocketRefBlock,
} from "@/lib/docket-ref-block";

const HEADING =
  "Docket references in this message (read one with the command shown; do not guess at what a reference means):";
const DIR = "/Users/k/src/tug";

describe("buildDocketRefBlock", () => {
  test("no entries is no block, not an empty one", () => {
    expect(buildDocketRefBlock([])).toBeNull();
  });

  test("a here docket names itself, its project and threads, and the read", () => {
    const block = buildDocketRefBlock([
      { value: "3f9a1c2e", verdict: "here", name: "GPU wedge", projectDir: DIR, threads: 4 },
    ]);
    expect(block).toBe(
      `${DOCKET_REFS_MARKER}\n${HEADING}\n`
      + `- @docket:3f9a1c2e — "GPU wedge", project ${DIR}, threads 4, verdict: here — read: tugtool docket show 3f9a1c2e`,
    );
  });

  test("a retired docket says so", () => {
    const block = buildDocketRefBlock([
      {
        value: "3f9a1c2e",
        verdict: "elsewhere",
        name: "Old work",
        projectDir: DIR,
        threads: 0,
        retired: true,
      },
    ]);
    expect(block).toContain(
      `- @docket:3f9a1c2e — "Old work", project ${DIR}, threads 0, retired, verdict: elsewhere — read: tugtool docket show 3f9a1c2e`,
    );
  });

  test("a quote in the name cannot end the quotes early", () => {
    const block = buildDocketRefBlock([
      { value: "3f9a1c2e", verdict: "here", name: 'the "big" one', projectDir: DIR },
    ]);
    expect(block).toContain(`"the 'big' one", project ${DIR}, verdict: here`);
  });

  test("absent says so plainly and offers no read", () => {
    const block = buildDocketRefBlock([{ value: "00ff00ff", verdict: "absent" }]);
    expect(block).toContain("- @docket:00ff00ff — verdict: absent — this docket is not on this machine");
    expect(block).not.toContain("docket show");
  });

  test("unverified names the command that settles it", () => {
    const block = buildDocketRefBlock([{ value: "12ab34cd", verdict: "unverified" }]);
    expect(block).toContain(
      "- @docket:12ab34cd — verdict: unverified — check: tugtool docket show 12ab34cd",
    );
  });
});

describe("parseDocketRefBlock", () => {
  test("recovers value, name, project and verdict from a built block", () => {
    const block = buildDocketRefBlock([
      { value: "3f9a1c2e", verdict: "here", name: "GPU wedge", projectDir: DIR, threads: 4 },
      {
        value: "4a4a4a4a",
        verdict: "elsewhere",
        name: "a, b",
        projectDir: "/u/a, b",
        threads: 1,
        retired: true,
      },
      { value: "00ff00ff", verdict: "absent" },
    ]);
    expect(parseDocketRefBlock(block ?? "")).toEqual([
      { value: "3f9a1c2e", name: "GPU wedge", projectDir: DIR, verdict: "here" },
      { value: "4a4a4a4a", name: "a, b", projectDir: "/u/a, b", verdict: "elsewhere" },
    ]);
  });

  test("a text that is not the block parses to nothing", () => {
    expect(isDocketRefBlock("hello")).toBe(false);
    expect(parseDocketRefBlock('- @docket:3f9a1c2e — "x", project /x, verdict: here')).toEqual([]);
  });
});
