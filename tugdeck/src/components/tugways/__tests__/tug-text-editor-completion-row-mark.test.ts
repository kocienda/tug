/**
 * The mark a completion row wears: a session's dot, a commit's ring, and
 * nothing for the kinds a row's label already tells apart.
 */

import { describe, expect, test } from "bun:test";

import { COMMIT_ATOM_TYPE } from "@/lib/command-atom";
import { SESSION_ATOM_TYPE } from "@/lib/session-atom-shape";
import { completionRowMark } from "../tug-text-editor";

describe("completionRowMark", () => {
  test("a session row wears the dot its chip leads with", () => {
    expect(completionRowMark(SESSION_ATOM_TYPE)).toBe("dot");
  });

  test("a commit row wears the ring its chip leads with", () => {
    expect(completionRowMark(COMMIT_ATOM_TYPE)).toBe("ring");
  });

  test("file and command rows are unchanged", () => {
    expect(completionRowMark("file")).toBeNull();
    expect(completionRowMark("command")).toBeNull();
  });
});
