import { describe, expect, test } from "bun:test";

import { deepEqual } from "../deep-equal";

describe("deepEqual", () => {
  test("primitives and identity", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual("a", "a")).toBe(true);
  });

  test("arrays and plain objects, nested", () => {
    expect(deepEqual([1, { a: [2, 3] }], [1, { a: [2, 3] }])).toBe(true);
    expect(deepEqual([1, { a: [2, 3] }], [1, { a: [2, 4] }])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual([], {})).toBe(false);
  });

  test("maps and sets", () => {
    expect(
      deepEqual(new Map([[1, { x: 1 }]]), new Map([[1, { x: 1 }]])),
    ).toBe(true);
    expect(deepEqual(new Map([[1, 1]]), new Map([[2, 1]]))).toBe(false);
    expect(deepEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(deepEqual(new Set([1]), new Set([1, 2]))).toBe(false);
  });

  test("class instances compare by reference", () => {
    class Thing {
      constructor(public n: number) {}
    }
    const a = new Thing(1);
    expect(deepEqual(a, a)).toBe(true);
    expect(deepEqual(a, new Thing(1))).toBe(false);
    expect(deepEqual({ n: 1 }, new Thing(1))).toBe(false);
  });
});
