/**
 * Pure-logic tests for `GlobToolBlock`'s wire-narrowing helpers, the
 * `Glob` dispatch routing, and a fixture-replay count check against
 * the stream-json catalog's `test-21-glob-tool.jsonl`.
 *
 * The wrapper component itself is decoration over composition
 * (`BlockChrome` + `embedded` `PathListBlock`) — its behaviour
 * *is* the exported pure helpers:
 *
 *  - `narrowGlobInput` / `narrowGlobStructured` — defensive narrowing
 *    of the `unknown` wire props.
 *  - `composeGlobPathListData` — `structured_result` → `PathListData`;
 *    `truncatedAt` is the producer's pre-truncation total when
 *    `truncated` is set, and an empty `filenames` array still composes
 *    a (zero-length) result.
 *  - `composeGlobCountLabel` — the header `{N} files` badge.
 *  - the dispatch routes `Glob` (any casing) to the real
 *    `GlobToolBlock`.
 *
 * The fixture-replay test is the [#step-15] "replay
 * `test-21-glob-tool.jsonl` → GlobToolBlock with PathListBlock,
 * correct count" gate: it loads the real catalog probe, narrows its
 * `tool_use_structured` event, and asserts the 100-file truncated
 * result flows through to `PathListData`. (The dispatch *routing* for
 * the same probe is pinned by `assistant-rendering-fixture-replay.test.ts`.)
 *
 * No DOM: per the project's testing policy these are `bun:test`
 * pure-logic assertions, not fake-DOM render tests.
 */

import { describe, expect, test } from "bun:test";

import {
  GlobToolBlock,
  composeGlobCountLabel,
  composeGlobPathListData,
  narrowGlobInput,
  narrowGlobStructured,
} from "../glob-tool-block";
import {
  _resetToolBlockRegistryForTests,
  registerToolBlock,
  resolveToolBlock,
} from "../../session-assistant-renderer-dispatch";
import { loadGoldenProbe } from "@/lib/code-session-store/testing/golden-catalog";

// ---------------------------------------------------------------------------
// narrowGlobInput
// ---------------------------------------------------------------------------

describe("narrowGlobInput", () => {
  test("keeps the wire fields when well-typed", () => {
    expect(
      narrowGlobInput({ pattern: "dash/**/*.md", path: "/repo" }),
    ).toEqual({ pattern: "dash/**/*.md", path: "/repo" });
  });

  test("drops mistyped fields and tolerates non-objects", () => {
    expect(narrowGlobInput({ pattern: 42, path: ["x"] })).toEqual({
      pattern: undefined,
      path: undefined,
    });
    expect(narrowGlobInput(null)).toEqual({});
    expect(narrowGlobInput("nope")).toEqual({});
    expect(narrowGlobInput(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// narrowGlobStructured
// ---------------------------------------------------------------------------

describe("narrowGlobStructured", () => {
  test("narrows a well-formed structured result", () => {
    const result = narrowGlobStructured({
      filenames: ["a.ts", "b.ts"],
      numFiles: 2,
      truncated: false,
      durationMs: 12,
      // A field the wrapper does not consume is ignored, not retained.
      cwd: "/repo",
    });
    expect(result).toEqual({
      filenames: ["a.ts", "b.ts"],
      numFiles: 2,
      truncated: false,
      durationMs: 12,
    });
  });

  test("filters non-string entries out of the filenames array", () => {
    expect(
      narrowGlobStructured({ filenames: ["a.ts", 7, null, "b.ts"] }).filenames,
    ).toEqual(["a.ts", "b.ts"]);
  });

  test("a missing or mistyped filenames array narrows to undefined", () => {
    expect(narrowGlobStructured({ numFiles: 3 }).filenames).toBeUndefined();
    expect(narrowGlobStructured({ filenames: "a.ts" }).filenames).toBeUndefined();
  });

  test("tolerates non-objects", () => {
    expect(narrowGlobStructured(null)).toEqual({});
    expect(narrowGlobStructured("nope")).toEqual({});
    expect(narrowGlobStructured(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// composeGlobPathListData
// ---------------------------------------------------------------------------

describe("composeGlobPathListData", () => {
  test("a complete result composes paths with no truncation total", () => {
    expect(
      composeGlobPathListData({
        filenames: ["a.ts", "b.ts"],
        numFiles: 2,
        truncated: false,
      }),
    ).toEqual({ paths: ["a.ts", "b.ts"], truncatedAt: undefined });
  });

  test("a truncated result carries numFiles as the truncatedAt total", () => {
    expect(
      composeGlobPathListData({
        filenames: ["a.ts", "b.ts"],
        numFiles: 100,
        truncated: true,
      }),
    ).toEqual({ paths: ["a.ts", "b.ts"], truncatedAt: 100 });
  });

  test("truncated with no numFiles falls back to the array length", () => {
    expect(
      composeGlobPathListData({
        filenames: ["a.ts", "b.ts"],
        truncated: true,
      }),
    ).toEqual({ paths: ["a.ts", "b.ts"], truncatedAt: 2 });
  });

  test("an empty filenames array still composes a zero-length result", () => {
    expect(composeGlobPathListData({ filenames: [] })).toEqual({
      paths: [],
      truncatedAt: undefined,
    });
  });

  test("no filenames array at all composes undefined (drift / streaming)", () => {
    expect(composeGlobPathListData({ numFiles: 3 })).toBeUndefined();
    expect(composeGlobPathListData({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// composeGlobCountLabel
// ---------------------------------------------------------------------------

describe("composeGlobCountLabel", () => {
  test("prefers numFiles and pluralizes", () => {
    expect(composeGlobCountLabel({ numFiles: 0 })).toBe("0 files");
    expect(composeGlobCountLabel({ numFiles: 1 })).toBe("1 file");
    expect(composeGlobCountLabel({ numFiles: 100 })).toBe("100 files");
  });

  test("falls back to the filenames length when numFiles is absent", () => {
    expect(composeGlobCountLabel({ filenames: ["a.ts", "b.ts"] })).toBe(
      "2 files",
    );
  });

  test("undefined when neither count is known", () => {
    expect(composeGlobCountLabel({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatch routing — Glob → GlobToolBlock
// ---------------------------------------------------------------------------

describe("Glob dispatch routing", () => {
  test("resolveToolBlock routes Glob (any casing) to GlobToolBlock", () => {
    // Re-establish a hermetic registry so this assertion is
    // independent of module-load order.
    _resetToolBlockRegistryForTests();
    registerToolBlock("glob", GlobToolBlock);
    expect(resolveToolBlock("glob")).toBe(GlobToolBlock);
    expect(resolveToolBlock("Glob")).toBe(GlobToolBlock);
    expect(resolveToolBlock("GLOB")).toBe(GlobToolBlock);
  });
});

// ---------------------------------------------------------------------------
// Fixture replay — test-21-glob-tool.jsonl → PathListData, correct count
// ---------------------------------------------------------------------------

describe("fixture replay — test-21-glob-tool.jsonl", () => {
  test("the catalog's Glob structured result narrows to a 100-file truncated PathListData", () => {
    const probe = loadGoldenProbe("v2.1.105", "test-21-glob-tool");

    // The Glob result lands on the `tool_use_structured` event — the
    // same event the live transcript folds into `ToolUseMessage.structuredResult`.
    const structuredEvent = probe.events.find(
      (e) => e.type === "tool_use_structured",
    );
    expect(structuredEvent, "probe must carry a tool_use_structured event").toBeDefined();
    if (structuredEvent === undefined) throw new Error("unreachable");

    const structured = narrowGlobStructured(structuredEvent.structured_result);
    // The fixture's Glob run found 100 files and capped the result.
    expect(structured.filenames?.length).toBe(100);
    expect(structured.numFiles).toBe(100);
    expect(structured.truncated).toBe(true);

    const pathListData = composeGlobPathListData(structured);
    expect(pathListData).toBeDefined();
    if (pathListData === undefined) throw new Error("unreachable");
    expect(pathListData.paths.length).toBe(100);
    expect(pathListData.truncatedAt).toBe(100);

    // The header count label reflects the same count.
    expect(composeGlobCountLabel(structured)).toBe("100 files");
  });
});
