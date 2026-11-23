/**
 * What each atom files, and how a filing's outcomes are worded.
 */
import { describe, expect, test } from "bun:test";

import type { DocketFileOutcome } from "../../protocol";
import { fileItemOf, filingSentence } from "../docket-filing";
import type { AtomSegment } from "../tug-atom-img";

const HERE = "/u/src/tug";

function atom(type: string, value: string, extra: Partial<AtomSegment> = {}): AtomSegment {
  return { kind: "atom", type, label: value, value, ...extra };
}

describe("fileItemOf", () => {
  test("an arc atom files its arc in the checkout it recorded", () => {
    expect(fileItemOf(atom("arc", "tug/rail"), HERE)).toEqual({
      kind: "arc",
      name: "rail",
      project_dir: HERE,
    });
    expect(
      fileItemOf(
        atom("arc", "other/rail", {
          arc: { projectDir: "/u/src/other", created: "2026-11-20T00:00:00Z" },
        }),
        HERE,
      ),
    ).toEqual({
      kind: "arc",
      name: "rail",
      project_dir: "/u/src/other",
      created: "2026-11-20T00:00:00Z",
    });
  });

  test("a sketch atom files its sketch", () => {
    expect(fileItemOf(atom("sketch", "0a1b2c3d"), HERE)).toEqual({
      kind: "sketch",
      id: "0a1b2c3d",
    });
  });

  test("a session atom files by uuid when it has one, else by callsign", () => {
    expect(
      fileItemOf(
        atom("session", "tug/mighty-cabin", {
          session: { id: "048e4155-f644-46f7-a839-d22ac02a564f", projectDir: HERE },
        }),
        HERE,
      ),
    ).toEqual({
      kind: "session",
      uuid: "048e4155-f644-46f7-a839-d22ac02a564f",
      project_dir: HERE,
    });
    expect(fileItemOf(atom("session", "tug/mighty-cabin"), HERE)).toEqual({
      kind: "session",
      callsign: "mighty-cabin",
      project_dir: HERE,
    });
  });

  test("a commit atom files its commit", () => {
    expect(fileItemOf(atom("commit", "63de5762a"), HERE)).toEqual({
      kind: "commit",
      sha: "63de5762a",
    });
  });

  test("a markdown file atom files as a brief, and nothing else does", () => {
    expect(fileItemOf(atom("file", "briefs/docket-loop-brief.md"), HERE)).toEqual({
      kind: "brief",
      path: "briefs/docket-loop-brief.md",
    });
    expect(fileItemOf(atom("file", "shots/rail.png"), HERE)).toBeNull();
    expect(fileItemOf(atom("image", "shots/rail.png"), HERE)).toBeNull();
    expect(fileItemOf(atom("directory", "briefs"), HERE)).toBeNull();
    expect(fileItemOf(atom("link", "https://example.com/a.md"), HERE)).toBeNull();
  });
});

let serial = 0;
function outcome(
  word: DocketFileOutcome["outcome"],
  extra: Partial<DocketFileOutcome> = {},
): DocketFileOutcome {
  serial += 1;
  return { key: `k-${serial}`, outcome: word, from: null, reason: null, ...extra };
}

const NOT_HERE =
  "It belongs to another checkout, and a docket holds only its own checkout's work.";

describe("filingSentence", () => {
  const names = new Map([["aaaa0001", "Rail work"]]);

  test("each part counts only what is there, in order", () => {
    expect(
      filingSentence(
        [
          outcome("filed"),
          outcome("filed"),
          outcome("moved", { from: { id: "aaaa0001", name: "Old name" } }),
          outcome("refused", { reason: NOT_HERE }),
        ],
        names,
      ),
    ).toBe("Filed 2 · moved 1 from *Rail work* · 1 refused: not this checkout");
  });

  test("a move names the docket the answer carried when the card does not know it", () => {
    expect(
      filingSentence([outcome("moved", { from: { id: "cccc0001", name: "Elsewhere" } })], names),
    ).toBe("Moved 1 from *Elsewhere*");
  });

  test("moves from two dockets name both", () => {
    expect(
      filingSentence(
        [
          outcome("moved", { from: { id: "aaaa0001", name: "x" } }),
          outcome("moved", { from: { id: "cccc0001", name: "Elsewhere" } }),
        ],
        names,
      ),
    ).toBe("Moved 2 from *Rail work* and *Elsewhere*");
  });

  test("already-filed items and distinct refusals are said once each", () => {
    expect(
      filingSentence(
        [
          outcome("already"),
          outcome("refused", { reason: "No commit 123abc in this checkout." }),
          outcome("refused", { reason: NOT_HERE }),
          outcome("refused", { reason: NOT_HERE }),
        ],
        names,
      ),
    ).toBe("1 already here · 3 refused: no commit 123abc in this checkout; not this checkout");
  });

  test("an empty filing says nothing", () => {
    expect(filingSentence([], names)).toBe("");
  });
});
