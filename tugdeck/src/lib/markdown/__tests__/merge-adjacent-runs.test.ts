/**
 * merge-adjacent-runs.test — a styled span serialises as one marked span, not
 * as N of them.
 *
 * `applyMarks` wraps one run at a time and a run is one DOM text node, so a
 * `<code>` holding two text nodes used to earn two pairs of backticks. The
 * merge that fixes it is a pure pass over the runs, before any marker is
 * written, and this is where its predicate is pinned: same block element, same
 * marks, neither side raw and neither carrying an atom.
 *
 * No DOM — a run's block element is compared by identity and nothing else, so
 * the tests hand it an opaque token. That is what the merge actually reads.
 */

import { describe, expect, test } from "bun:test";

import {
  mergeAdjacentRuns,
  type BlockInfo,
  type Marks,
  type Run,
} from "@/lib/markdown/serialize-selection";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";

/** A block the runs can share by identity. The element is never dereferenced. */
function block(): BlockInfo {
  return { el: {} as Element, kind: "p", level: 0, inQuote: false };
}

function run(text: string, b: BlockInfo, marks: Marks = {}): Run {
  return { text, block: b, marks, raw: false };
}

/** An atom's run: raw, and carrying the segment it stands for. */
function atomRun(b: BlockInfo, atom: AtomSegment): Run {
  return { text: TUG_ATOM_CHAR, block: b, marks: {}, raw: true, atom };
}

const ATOM: AtomSegment = {
  kind: "atom",
  type: "commit",
  label: "commit:64747b8c",
  value: "64747b8c9a",
};

describe("mergeAdjacentRuns", () => {
  test("two text nodes under one <code> become one run", () => {
    // The defect verbatim: two runs each earning their own backticks read back
    // as `` `commit:``64747b8c` `` rather than as one code span.
    const b = block();
    const merged = mergeAdjacentRuns([
      run("commit:", b, { code: true }),
      run("64747b8c", b, { code: true }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.text).toBe("commit:64747b8c");
    expect(merged[0]!.marks).toEqual({ code: true });
  });

  test("the one-text-node case comes out byte-identical", () => {
    // The merge must be invisible where there is nothing to merge — this is
    // the whole of its blast radius on every selection that was already right.
    const b = block();
    const runs = [
      run("plain ", b),
      run("bold", b, { bold: true }),
      run(" and ", b),
      run("link", b, { href: "https://example.invalid" }),
    ];
    const merged = mergeAdjacentRuns(runs);
    expect(merged).toEqual(runs);
  });

  test("runs with different marks are left alone", () => {
    const b = block();
    const runs = [run("a", b, { code: true }), run("b", b, { bold: true })];
    expect(mergeAdjacentRuns(runs)).toEqual(runs);
  });

  test("one mark differing by a single field is enough to keep them apart", () => {
    const b = block();
    const runs = [
      run("a", b, { code: true, bold: true }),
      run("b", b, { code: true }),
    ];
    expect(mergeAdjacentRuns(runs)).toEqual(runs);
  });

  test("two links to different places are two runs", () => {
    const b = block();
    const runs = [
      run("here", b, { href: "https://a.invalid" }),
      run("there", b, { href: "https://b.invalid" }),
    ];
    expect(mergeAdjacentRuns(runs)).toEqual(runs);
  });

  test("runs in different blocks never merge, however alike their marks", () => {
    // The block boundary is what `selectionToTranscriptSubstrate` groups on,
    // and a merge across one would fold two paragraphs into a single line.
    const runs = [run("a", block(), { code: true }), run("b", block(), { code: true })];
    expect(mergeAdjacentRuns(runs)).toEqual(runs);
  });

  test("an atom's run is never merged into its neighbours", () => {
    // A merged atom run would take its `atom` field out of the sequence the
    // `U+FFFC` characters are paired against, and the substrate's text and
    // atoms would stop lining up.
    const b = block();
    const runs = [run("see ", b), atomRun(b, ATOM), run(" there", b)];
    const merged = mergeAdjacentRuns(runs);
    expect(merged).toEqual(runs);
    expect(merged[1]!.atom).toBe(ATOM);
  });

  test("a raw run neither merges nor absorbs — pre-formatted text stays verbatim", () => {
    const b = block();
    const runs = [
      { text: "x = 1", block: b, marks: {}, raw: true },
      { text: "y = 2", block: b, marks: {}, raw: true },
    ];
    expect(mergeAdjacentRuns(runs)).toEqual(runs);
  });

  test("three text nodes under one span collapse to one", () => {
    const b = block();
    const merged = mergeAdjacentRuns([
      run("one", b, { bold: true }),
      run(" two", b, { bold: true }),
      run(" three", b, { bold: true }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.text).toBe("one two three");
  });

  test("the input runs are not written through", () => {
    // `collectRuns`' objects are the caller's; a merge that mutated them would
    // be a side effect on an input, and the second call would see the first.
    const b = block();
    const first = run("commit:", b, { code: true });
    mergeAdjacentRuns([first, run("64747b8c", b, { code: true })]);
    expect(first.text).toBe("commit:");
  });

  test("an empty selection stays empty", () => {
    expect(mergeAdjacentRuns([])).toEqual([]);
  });
});
