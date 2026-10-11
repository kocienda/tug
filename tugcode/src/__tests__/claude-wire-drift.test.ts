/**
 * The wire drift test: Claude's raw stream-json, as the catalog captured it,
 * against the union `claude-wire.ts` declares.
 *
 * Every `v<version>/wire/*.jsonl` the capture recorded is read line by line
 * and narrowed with {@link isClaudeWireMessage}. The counterpart of
 * `stream_json_catalog_drift.rs`, which says "tugcode's output moved"; this
 * one says "Claude's output moved".
 *
 * A line whose discriminants the union does not declare is counted and
 * listed, not failed: Claude adding a message kind is not a Tug bug until
 * Tug relies on it, and the list is what tells the next reader which member
 * to declare. What fails is a capture that cannot be read — no `wire/` at
 * all, or a line that is not JSON — because then nothing was checked.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isClaudeWireMessage, wireKindOf } from "../claude-wire.ts";

const CATALOG = join(
  import.meta.dir,
  "../../../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog",
);

/** A line the capture recorded as non-JSON (`read_wire_tap`'s placeholder). */
const NONJSON_PLACEHOLDER = /^\{\{nonjson:len=\d+\}\}$/;

interface WireFile {
  version: string;
  name: string;
  lines: string[];
}

function capturedWireFiles(): WireFile[] {
  const files: WireFile[] = [];
  for (const version of readdirSync(CATALOG).sort()) {
    const dir = join(CATALOG, version, "wire");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const lines = readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      files.push({ version, name, lines });
    }
  }
  return files;
}

/**
 * One captured line's verdict. The capture writes a non-JSON stdout line as
 * its placeholder bare (`{{nonjson:len=N}}`, not a JSON string), so the
 * placeholder is recognised before the line is parsed.
 */
type LineVerdict = "known" | "nonjson" | "unparsed" | { undeclared: string };

function classifyWireLine(line: string): LineVerdict {
  if (NONJSON_PLACEHOLDER.test(line)) return "nonjson";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "unparsed";
  }
  return isClaudeWireMessage(value) ? "known" : { undeclared: wireKindOf(value) };
}

describe("Claude's captured wire against ClaudeWireMessage", () => {
  const files = capturedWireFiles();

  test("the catalog carries a raw wire capture to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("a non-JSON line, as the capture records it, counts as non-JSON rather than failing", () => {
    // The form `read_wire_tap` writes in `tests/common/catalog.rs`.
    expect(classifyWireLine("{{nonjson:len=8}}")).toBe("nonjson");
    expect(classifyWireLine("not json")).toBe("unparsed");
    expect(classifyWireLine('{"type":"keep_alive"}')).toBe("known");
    expect(classifyWireLine('{"type":"brand_new"}')).toEqual({ undeclared: "brand_new" });
  });

  test("every captured line narrows to a declared member, unknown members listed", () => {
    const unknown = new Map<string, string[]>();
    const unparsed: string[] = [];
    let known = 0;
    let nonJson = 0;

    for (const file of files) {
      file.lines.forEach((line, i) => {
        const at = `${file.version}/wire/${file.name}:${i + 1}`;
        const verdict = classifyWireLine(line);
        if (verdict === "known") known += 1;
        else if (verdict === "nonjson") nonJson += 1;
        else if (verdict === "unparsed") unparsed.push(at);
        else unknown.set(verdict.undeclared, [...(unknown.get(verdict.undeclared) ?? []), at]);
      });
    }

    const unknownCount = [...unknown.values()].reduce((n, at) => n + at.length, 0);
    console.log(
      `[wire-drift] ${files.length} files: ${known} lines narrow, ` +
        `${unknownCount} undeclared, ${nonJson} non-JSON stdout lines`,
    );
    for (const [kind, at] of [...unknown].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`[wire-drift] undeclared ${kind} ×${at.length} (first: ${at[0]})`);
    }

    expect(unparsed).toEqual([]);
    expect(known).toBeGreaterThan(0);
  });
});
