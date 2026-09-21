import { describe, expect, test } from "bun:test";

import {
  MAX_EDIT_DISTANCE,
  minimalTextChanges,
  type TextChange,
} from "../minimal-text-changes";

/** Apply `changes` (offsets of `prev`) the way a CM6 transaction would. */
function apply(prev: string, changes: readonly TextChange[]): string {
  let out = "";
  let at = 0;
  for (const c of changes) {
    expect(c.from).toBeGreaterThanOrEqual(at);
    expect(c.to).toBeGreaterThanOrEqual(c.from);
    out += prev.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + prev.slice(at);
}

function lines(n: number, tag = ""): string {
  return Array.from({ length: n }, (_, i) => `line ${i}${tag}\n`).join("");
}

describe("minimalTextChanges", () => {
  test("equal texts produce no changes", () => {
    expect(minimalTextChanges("abc\n", "abc\n")).toEqual([]);
  });

  test("a one-word edit deep in a file is one small change", () => {
    const prev = lines(500);
    const next = prev.replace("line 250\n", "LINE 250\n");
    const changes = minimalTextChanges(prev, next);
    expect(changes).toHaveLength(1);
    expect(changes[0].insert).toBe("LINE");
    expect(changes[0].to - changes[0].from).toBe(4);
    expect(apply(prev, changes)).toBe(next);
  });

  test("separate edits stay separate, leaving the text between untouched", () => {
    const prev = lines(300);
    const next = prev
      .replace("line 10\n", "line ten\n")
      .replace("line 200\n", "")
      .replace("line 290\n", "line 290\nadded\n");
    const changes = minimalTextChanges(prev, next);
    expect(changes).toHaveLength(3);
    expect(apply(prev, changes)).toBe(next);
  });

  test("an insertion above leaves every later offset mappable", () => {
    const prev = lines(100);
    const next = "new first line\n" + prev;
    const changes = minimalTextChanges(prev, next);
    expect(changes).toEqual([{ from: 0, to: 0, insert: "new first line\n" }]);
  });

  test("handles empty sides and a missing final newline", () => {
    for (const [p, n] of [
      ["", "a\nb"],
      ["a\nb", ""],
      ["a\nb", "a\nb\n"],
      ["a\nb\n", "a\nb"],
      ["x", "y"],
    ]) {
      expect(apply(p, minimalTextChanges(p, n))).toBe(n);
    }
  });

  test("never splits a surrogate pair", () => {
    const prev = "say 😀 now\n";
    const next = "say 😁 now\n";
    const changes = minimalTextChanges(prev, next);
    expect(apply(prev, changes)).toBe(next);
    expect(changes).toEqual([{ from: 4, to: 6, insert: "😁" }]);
  });

  test("a rewrite past the distance ceiling collapses to the middle span", () => {
    const keepHead = "head\n";
    const keepTail = "tail\n";
    const prev = keepHead + lines(MAX_EDIT_DISTANCE, "a") + keepTail;
    const next = keepHead + lines(MAX_EDIT_DISTANCE, "b") + keepTail;
    const changes = minimalTextChanges(prev, next);
    expect(changes).toHaveLength(1);
    expect(changes[0].from).toBeGreaterThanOrEqual(keepHead.length);
    expect(changes[0].to).toBeLessThanOrEqual(prev.length - keepTail.length);
    expect(apply(prev, changes)).toBe(next);
  });

  test("random edits always round-trip", () => {
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rand(40) }, () => `l${rand(12)}`);
      const b = a.slice();
      for (let e = rand(8); e > 0; e--) {
        const at = rand(b.length + 1);
        const op = rand(3);
        if (op === 0) b.splice(at, 0, `n${rand(12)}`);
        else if (op === 1) b.splice(at, 1);
        else if (at < b.length) b[at] = b[at] + "!";
      }
      const prev = a.join("\n");
      const next = b.join("\n");
      expect(apply(prev, minimalTextChanges(prev, next))).toBe(next);
    }
  });
});
