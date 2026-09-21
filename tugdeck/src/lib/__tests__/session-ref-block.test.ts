/**
 * session-ref-block.test.ts — the trailing block that resolves a message's
 * session references.
 *
 * Two halves with different bars. The BUILD half is read by a model, so its
 * exact text matters: a verdict word, a uuid, and the command that acts on
 * it. The PARSE half is read by a replay, and its bar is that it never
 * refuses — a line it does not recognise is skipped, because rejecting a
 * block would mean losing a message over plumbing.
 */

import { describe, expect, test } from "bun:test";

import {
  SESSION_REFS_MARKER,
  buildSessionRefBlock,
  isSessionRefBlock,
  parseSessionRefBlock,
} from "@/lib/session-ref-block";

const ID = "0f3c1e5a-1111-2222-3333-444455556666";
const DIR = "/u/src/eucit";

describe("buildSessionRefBlock", () => {
  test("no entries is no block, not an empty one", () => {
    // A message with no session atom must be byte-identical to what it was
    // before this block existed.
    expect(buildSessionRefBlock([])).toBeNull();
  });

  test("an entry with an identity names the uuid, the project, and the read", () => {
    const block = buildSessionRefBlock([
      {
        value: "eucit/curly-apple",
        verdict: "elsewhere",
        sessionId: ID,
        projectDir: DIR,
      },
    ]);
    expect(block).toBe(
      `${SESSION_REFS_MARKER}\n`
      + "Session references in this message (read one with the command shown; do not guess at what a reference means):\n"
      + `- @session:eucit/curly-apple — uuid ${ID}, project ${DIR}, verdict: elsewhere — read: tugtool session show ${ID}`,
    );
  });

  test("absent says so plainly and offers no read", () => {
    // There is nothing to read, and a command that would fail is worse than
    // no command: the model is being told to stop, not to try harder.
    const block = buildSessionRefBlock([
      { value: "tug/odd-kiln", verdict: "absent" },
    ]);
    expect(block).toContain(
      "- @session:tug/odd-kiln — verdict: absent — this session is not on this machine",
    );
    expect(block).not.toContain("session show");
  });

  test("unverified names the command that settles it", () => {
    const block = buildSessionRefBlock([
      { value: "tug/odd-kiln", verdict: "unverified" },
    ]);
    expect(block).toContain(
      "- @session:tug/odd-kiln — verdict: unverified — check: tugtool session find tug/odd-kiln",
    );
  });

  test("a verdict with only half an identity falls back to the check line", () => {
    // A uuid with no project dir cannot be printed as a resolved reference
    // without inventing the other half.
    const block = buildSessionRefBlock([
      { value: "tug/odd-kiln", verdict: "here", sessionId: ID },
    ]);
    expect(block).toContain("check: tugtool session find tug/odd-kiln");
    expect(block).not.toContain("uuid ");
  });

  test("several entries are several lines, in the order given", () => {
    const block = buildSessionRefBlock([
      { value: "a/one", verdict: "absent" },
      { value: "b/two", verdict: "here", sessionId: ID, projectDir: DIR },
    ]);
    const lines = (block ?? "").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("@session:a/one");
    expect(lines[3]).toContain("@session:b/two");
  });
});

describe("isSessionRefBlock", () => {
  test("the marker opens the block, and nowhere else counts", () => {
    expect(isSessionRefBlock(`${SESSION_REFS_MARKER}\nanything`)).toBe(true);
    // Prose that merely mentions the marker is prose the user wrote.
    expect(isSessionRefBlock(`what does ${SESSION_REFS_MARKER} mean?`)).toBe(false);
    expect(isSessionRefBlock("hello")).toBe(false);
  });
});

describe("parseSessionRefBlock", () => {
  test("round-trips an identity out of a block it built", () => {
    const block = buildSessionRefBlock([
      {
        value: "eucit/curly-apple",
        verdict: "elsewhere",
        sessionId: ID,
        projectDir: DIR,
      },
    ]);
    expect(parseSessionRefBlock(block ?? "")).toEqual([
      {
        value: "eucit/curly-apple",
        sessionId: ID,
        projectDir: DIR,
        verdict: "elsewhere",
      },
    ]);
  });

  test("a project dir containing a comma survives", () => {
    // The dir is matched lazily up to the `, verdict:` tail, which is the one
    // thing a directory name cannot contain.
    const block = buildSessionRefBlock([
      { value: "a/b", verdict: "here", sessionId: ID, projectDir: "/u/src/a,b" },
    ]);
    expect(parseSessionRefBlock(block ?? "")[0].projectDir).toBe("/u/src/a,b");
  });

  test("an absent line yields no identity, and does not stop the others", () => {
    const block = buildSessionRefBlock([
      { value: "tug/odd-kiln", verdict: "absent" },
      { value: "a/b", verdict: "here", sessionId: ID, projectDir: DIR },
    ]);
    const parsed = parseSessionRefBlock(block ?? "");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].value).toBe("a/b");
  });

  test("a garbage line is ignored rather than refused", () => {
    const text = [
      SESSION_REFS_MARKER,
      "some heading a newer client wrote",
      "- @session:junk — this is not the shape",
      `- @session:a/b — uuid ${ID}, project ${DIR}, verdict: here — read: x`,
      "",
    ].join("\n");
    expect(parseSessionRefBlock(text).map((r) => r.value)).toEqual(["a/b"]);
  });

  test("text that is not the block parses to nothing", () => {
    expect(parseSessionRefBlock("hello")).toEqual([]);
  });
});
