/**
 * two-text-diff — the payload the Text card's compare sheet renders.
 *
 * The assertion that matters is a round trip: the `unified` text this module
 * builds is fed back through `parseUnifiedDiffText`, the very parser
 * `TugDiffDocument` reads it with, and the hunks that come out must name the
 * known difference. A diff that only *looks* right in a string comparison
 * would still render wrong if the parser disagreed about it, and the parser
 * is the consumer that counts.
 */

import { describe, test, expect } from "bun:test";

import { buildTwoTextDiffPayload } from "@/lib/diff/two-text-diff";
import { parseUnifiedDiffText } from "@/lib/diff/parse-unified-diff";
import { MAX_EDIT_DISTANCE } from "@/lib/minimal-text-changes";

const NAME = "notes.md";
const contentOf = (kind: string, hunks: ReturnType<typeof parseUnifiedDiffText>) =>
  hunks.flatMap((h) => h.lines.filter((l) => l.kind === kind).map((l) => l.content));

describe("buildTwoTextDiffPayload", () => {
  test("names the file and the base it compares against", () => {
    const payload = buildTwoTextDiffPayload(NAME, "a\n", "b\n");
    expect(payload.base).toBe("disk");
    expect(payload.no_repo).toBe(false);
    expect(payload.request_id).toBe("");
    expect(payload.workspace_key).toBe("");
    expect(payload.file_count).toBe(1);
    expect(payload.files[0]?.path).toBe(NAME);
    expect(payload.files[0]?.status).toBe("modified");
    expect(payload.files[0]?.binary).toBe(false);
    expect(payload.files[0]?.hunks).toBeUndefined();
    expect(payload.files[0]?.unified.startsWith(`--- a/${NAME}\n+++ b/${NAME}\n`)).toBe(
      true,
    );
  });

  test("a one-line change round-trips to exactly that add and remove", () => {
    const before = "one\ntwo\nthree\n";
    const after = "one\nTWO\nthree\n";
    const payload = buildTwoTextDiffPayload(NAME, before, after);
    const hunks = parseUnifiedDiffText(payload.files[0]!.unified);

    expect(hunks).toHaveLength(1);
    expect(contentOf("remove", hunks)).toEqual(["two"]);
    expect(contentOf("add", hunks)).toEqual(["TWO"]);
    expect(contentOf("context", hunks)).toEqual(["one", "three"]);
    expect(payload.total_added).toBe(1);
    expect(payload.total_removed).toBe(1);
  });

  test("the parsed line numbers address the right lines on both sides", () => {
    const before = "one\ntwo\nthree\nfour\nfive\n";
    const after = "one\ntwo\nTHREE\nfour\nfive\n";
    const hunks = parseUnifiedDiffText(
      buildTwoTextDiffPayload(NAME, before, after).files[0]!.unified,
    );
    const removed = hunks[0]!.lines.find((l) => l.kind === "remove");
    const addedLine = hunks[0]!.lines.find((l) => l.kind === "add");
    expect(removed?.before_lineno).toBe(3);
    expect(addedLine?.after_lineno).toBe(3);
    expect(hunks[0]!.before_start).toBe(1);
    expect(hunks[0]!.after_start).toBe(1);
  });

  test("two distant changes are two hunks; two near ones are merged into one", () => {
    const base = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
    const distant = base.replace("line 1\n", "LINE 1\n").replace("line 25\n", "LINE 25\n");
    expect(
      parseUnifiedDiffText(
        buildTwoTextDiffPayload(NAME, base, distant).files[0]!.unified,
      ),
    ).toHaveLength(2);

    const near = base.replace("line 10\n", "LINE 10\n").replace("line 14\n", "LINE 14\n");
    const nearHunks = parseUnifiedDiffText(
      buildTwoTextDiffPayload(NAME, base, near).files[0]!.unified,
    );
    expect(nearHunks).toHaveLength(1);
    // The four lines between them are printed once, as context — not twice.
    expect(contentOf("context", nearHunks).filter((c) => c === "line 12")).toEqual([
      "line 12",
    ]);
  });

  test("a pure insertion and a pure deletion each count only their own side", () => {
    const insertion = buildTwoTextDiffPayload(NAME, "a\nb\n", "a\nmiddle\nb\n");
    expect(insertion.total_added).toBe(1);
    expect(insertion.total_removed).toBe(0);

    const deletion = buildTwoTextDiffPayload(NAME, "a\nmiddle\nb\n", "a\nb\n");
    expect(deletion.total_added).toBe(0);
    expect(deletion.total_removed).toBe(1);
  });

  test("an empty side gets git's zero-length range, which the parser reads back", () => {
    const hunks = parseUnifiedDiffText(
      buildTwoTextDiffPayload(NAME, "", "fresh\n").files[0]!.unified,
    );
    expect(hunks[0]!.before_start).toBe(0);
    expect(hunks[0]!.before_count).toBe(0);
    expect(contentOf("add", hunks)).toEqual(["fresh"]);
  });

  test("a side whose last line has no terminator is marked, and parses cleanly", () => {
    const payload = buildTwoTextDiffPayload(NAME, "one\ntwo", "one\nTWO");
    expect(payload.files[0]!.unified).toContain("\\ No newline at end of file");
    const hunks = parseUnifiedDiffText(payload.files[0]!.unified);
    // The marker is skipped by the parser rather than read as a body line.
    expect(contentOf("remove", hunks)).toEqual(["two"]);
    expect(contentOf("add", hunks)).toEqual(["TWO"]);
  });

  test("identical texts produce no hunks at all", () => {
    const payload = buildTwoTextDiffPayload(NAME, "same\ntext\n", "same\ntext\n");
    expect(parseUnifiedDiffText(payload.files[0]!.unified)).toEqual([]);
    expect(payload.total_added).toBe(0);
    expect(payload.total_removed).toBe(0);
  });

  test("CRLF on one side alone is not a whole-file rewrite", () => {
    const payload = buildTwoTextDiffPayload(NAME, "one\r\ntwo\r\n", "one\ntwo\n");
    expect(parseUnifiedDiffText(payload.files[0]!.unified)).toEqual([]);
  });

  test("past MAX_EDIT_DISTANCE it degrades to one whole-file hunk", () => {
    const n = MAX_EDIT_DISTANCE + 200;
    const before = Array.from({ length: n }, (_, i) => `before ${i}\n`).join("");
    const after = Array.from({ length: n }, (_, i) => `after ${i}\n`).join("");
    const payload = buildTwoTextDiffPayload(NAME, before, after);
    const hunks = parseUnifiedDiffText(payload.files[0]!.unified);
    expect(hunks).toHaveLength(1);
    expect(payload.total_removed).toBe(n);
    expect(payload.total_added).toBe(n);
  });
});
