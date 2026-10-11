/**
 * The `decode` combinators: what each accepts, what it rejects, and the
 * `path` / `expected` / `got` a rejection reports — nested failures most of
 * all, since the path is what a decode-error log line is read for.
 */

import { describe, expect, test } from "bun:test";
import {
  arr,
  bool,
  decode,
  DecodeError,
  isDecodeError,
  lit,
  num,
  obj,
  opt,
  str,
  union,
} from "../decode";

function err(r: unknown): DecodeError {
  if (!isDecodeError(r)) throw new Error(`expected a DecodeError, got ${JSON.stringify(r)}`);
  return r;
}

describe("primitives", () => {
  test("accept their own kind", () => {
    expect(str("a", "$")).toBe("a");
    expect(str("", "$")).toBe("");
    expect(num(0, "$")).toBe(0);
    expect(num(-1.5, "$")).toBe(-1.5);
    expect(bool(false, "$")).toBe(false);
  });

  test("reject other kinds with expected and got", () => {
    expect({ ...err(str(1, "$")) }).toEqual({ tag: "", path: "$", expected: "string", got: "number 1" });
    expect(err(num("1", "$")).got).toBe('string "1"');
    expect(err(num(Number.NaN, "$")).expected).toBe("number");
    expect(err(bool(null, "$")).got).toBe("null");
    expect(err(str(undefined, "$")).got).toBe("undefined");
    expect(err(str({}, "$")).got).toBe("object");
    expect(err(str([1, 2], "$")).got).toBe("array(2)");
  });

  test("got truncates a long string", () => {
    const got = err(num("x".repeat(100), "$")).got;
    expect(got).toBe(`string "${"x".repeat(40)}…"`);
  });
});

describe("lit", () => {
  const status = lit("running", "done", null);

  test("accepts any listed literal", () => {
    expect(status("running", "$")).toBe("running");
    expect(status(null, "$")).toBeNull();
  });

  test("rejects anything else, listing the alternatives", () => {
    const e = err(status("Running", "$.status"));
    expect(e.path).toBe("$.status");
    expect(e.expected).toBe('"running" | "done" | null');
    expect(e.got).toBe('string "Running"');
    expect(isDecodeError(lit(1)("1", "$"))).toBe(true);
  });
});

describe("opt", () => {
  const d = opt(num);

  test("accepts absent and the inner kind", () => {
    expect(d(undefined, "$")).toBeUndefined();
    expect(d(3, "$")).toBe(3);
  });

  test("does not accept null unless the inner decoder does", () => {
    expect(err(d(null, "$.n")).path).toBe("$.n");
    expect(opt(lit(null))(null, "$")).toBeNull();
  });
});

describe("arr", () => {
  test("accepts arrays whose elements all decode, including empty", () => {
    expect(arr(str)([], "$")).toEqual([]);
    expect(arr(str)(["a", "b"], "$")).toEqual(["a", "b"]);
  });

  test("rejects a non-array", () => {
    expect(err(arr(str)("a", "$")).expected).toBe("array");
  });

  test("reports the first bad element's index", () => {
    const e = err(arr(num)([1, 2, "3", "4"], "$.xs"));
    expect(e.path).toBe("$.xs[2]");
    expect(e.got).toBe('string "3"');
  });
});

describe("obj", () => {
  const task = obj({ id: str, count: num, note: opt(str) });

  test("accepts a matching object and returns it as received", () => {
    const input = { id: "t1", count: 2, extra: [1] };
    const r = task(input, "$");
    expect(r).toBe(input);
  });

  test("accepts an optional field present or absent", () => {
    expect(isDecodeError(task({ id: "t", count: 1, note: "n" }, "$"))).toBe(false);
    expect(isDecodeError(task({ id: "t", count: 1 }, "$"))).toBe(false);
  });

  test("rejects non-objects, null and arrays", () => {
    expect(err(task(null, "$")).expected).toBe("object");
    expect(err(task([], "$")).got).toBe("array(0)");
    expect(err(task("x", "$")).got).toBe('string "x"');
  });

  test("a missing required field reports its path and undefined", () => {
    const e = err(task({ id: "t" }, "$"));
    expect(e.path).toBe("$.count");
    expect(e.got).toBe("undefined");
  });

  test("a wrong optional field still fails", () => {
    expect(err(task({ id: "t", count: 1, note: 5 }, "$")).path).toBe("$.note");
  });

  test("nested failures carry the full path", () => {
    const frame = obj({ task: obj({ steps: arr(obj({ name: str })) }) });
    const e = err(frame({ task: { steps: [{ name: "a" }, { name: 7 }] } }, "$"));
    expect(e.path).toBe("$.task.steps[1].name");
    expect(e.expected).toBe("string");
    expect(e.got).toBe("number 7");
  });
});

describe("union", () => {
  const started = obj({ kind: lit("started"), id: str });
  const progress = obj({ kind: lit("progress"), id: str, pct: num });
  const event = union(started, progress);

  test("accepts any alternative", () => {
    expect(isDecodeError(event({ kind: "started", id: "a" }, "$"))).toBe(false);
    expect(isDecodeError(event({ kind: "progress", id: "a", pct: 5 }, "$"))).toBe(false);
    expect(union(str, num)(4, "$")).toBe(4);
  });

  test("reports the deepest failure", () => {
    const e = err(event({ kind: "progress", id: "a", pct: "5" }, "$"));
    expect(e.path).toBe("$.pct");
    expect(e.expected).toBe("number");
  });

  test("joins expectations tied at the same depth", () => {
    expect(err(union(str, num)(true, "$")).expected).toBe("string | number");
    expect(err(event({ kind: "ended", id: "a" }, "$")).expected).toBe('"started" | "progress"');
  });
});

describe("decode", () => {
  const frame = obj({ type: lit("task_started"), task_id: str });

  test("returns the value when it decodes", () => {
    const input = { type: "task_started" as const, task_id: "t" };
    expect(decode("task_started", frame, input)).toBe(input);
  });

  test("stamps the tag and roots the path at $", () => {
    const e = err(decode("task_started", frame, { type: "task_started", task_id: 9 }));
    expect({ ...e }).toEqual({ tag: "task_started", path: "$.task_id", expected: "string", got: "number 9" });
    expect(e.toString()).toBe("task_started at $.task_id: expected string, got number 9");
  });
});

describe("types", () => {
  test("obj infers required and optional keys", () => {
    const d = obj({ a: str, b: opt(num), c: arr(lit("x", "y")) });
    const r = d({ a: "", c: [] }, "$");
    if (isDecodeError(r)) throw r;
    const a: string = r.a;
    const b: number | undefined = r.b;
    const c: ("x" | "y")[] = r.c;
    // @ts-expect-error — `a` is required, so the type rejects an object without it.
    const missing: typeof r = { c: [] };
    expect([a, b, c, missing] as unknown[]).toEqual(["", undefined, [], { c: [] }]);
  });
});
