/**
 * atom-plain-text.test — one plain-text spelling per atom kind, and the three
 * writers that now agree on it.
 *
 * `text/plain` is the flavor that leaves Tug, and it had three authors giving
 * three answers. The table below is the first half of this file: one row per
 * kind, so a new kind arriving without a spelling is a failing row rather than
 * a surprise on somebody's pasteboard.
 *
 * The second half is the part the report was actually about — the three call
 * sites reading the same string for the same atom. `formatAtomTextForCopy`
 * (the substrate copy behind a transcript row, a receipt, a user turn) and
 * `serializeClipboard` (the editor's own ⌘C) are checked here against
 * `atomPlainText` directly, on the two kinds they used to disagree about.
 * `atomPlainTextFor` — the annotation menu's — is checked at its own seam,
 * since its one remaining arm needs a session id the substrate does not carry.
 */

import { describe, expect, test } from "bun:test";

import { atomPlainText } from "@/lib/atom-plain-text";
import { formatAtomTextForCopy } from "@/lib/atom-text";
import { serializeClipboard } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";

/** An atom of `type`, as the substrate carries it. */
function atom(type: string, label: string, value: string): AtomSegment {
  return { kind: "atom", type, label, value };
}

const SHA = "64747b8c9a1d3f0e5b2c7a8d9e0f1a2b3c4d5e6f";

describe("the table — one spelling per kind", () => {
  const rows: Array<[string, AtomSegment, string]> = [
    [
      "a commit spells itself, never a markdown link with a sha for a URL",
      atom("commit", "commit:64747b8c", SHA),
      "commit:64747b8c",
    ],
    [
      "a commit whose label was drawn some other way still spells from its sha",
      atom("commit", "whatever the pill drew", SHA),
      "commit:64747b8c",
    ],
    [
      "a session writes the identity line the segment holds",
      atom("session", "tugtool/stocky-pixie", "tugtool/stocky-pixie"),
      "tugtool/stocky-pixie",
    ],
    [
      "a command keeps the leading slash it is drawn with",
      atom("command", "tugplug:arc", "tugplug:arc"),
      "/tugplug:arc",
    ],
    [
      "a command whose value already carries the slash does not gain a second",
      atom("command", "arc-implement", "/arc-implement"),
      "/arc-implement",
    ],
    [
      "a file keeps its path — that is information a plain paste should carry",
      atom("file", "atom-text.ts", "tugdeck/src/lib/atom-text.ts"),
      "[atom-text.ts](<tugdeck/src/lib/atom-text.ts>)",
    ],
    [
      "a directory the same way, with no trailing separator to spell",
      atom("directory", "annotator", "tugdeck/src/lib/annotator"),
      "[annotator](<tugdeck/src/lib/annotator>)",
    ],
    [
      "a link is its label over its url",
      atom("link", "the brief", "https://example.invalid/brief"),
      "[the brief](<https://example.invalid/brief>)",
    ],
    [
      "an image is its name — its value is a handle, never a place",
      atom("image", "shot.png", "shot.png"),
      "shot.png",
    ],
    [
      "a dropped file exposes no path, so the redundant link collapses",
      atom("file", "raphael.jpeg", "raphael.jpeg"),
      "raphael.jpeg",
    ],
  ];
  for (const [name, segment, expected] of rows) {
    test(name, () => {
      expect(atomPlainText(segment)).toBe(expected);
    });
  }

  test("a path with a space stays inside angle brackets", () => {
    // Without them CommonMark's link parser stops at the space and the rest of
    // the path lands in the reader's prose.
    expect(atomPlainText(atom("file", "notes.md", "my docs/notes.md"))).toBe(
      "[notes.md](<my docs/notes.md>)",
    );
  });

  test("an empty value is the label alone, not an empty link", () => {
    expect(atomPlainText(atom("file", "untitled", ""))).toBe("untitled");
  });
});

describe("the writers agree", () => {
  // The two kinds [F03] found them disagreeing on: a commit, whose label and
  // value differ on purpose, and a file, whose value carries the path.
  const cases: AtomSegment[] = [
    atom("commit", "commit:64747b8c", SHA),
    atom("file", "atom-text.ts", "tugdeck/src/lib/atom-text.ts"),
    atom("command", "tugplug:arc", "tugplug:arc"),
    atom("image", "shot.png", "shot.png"),
  ];

  test("the substrate copy writes the table's string", () => {
    for (const segment of cases) {
      expect(formatAtomTextForCopy(`see ${TUG_ATOM_CHAR} here`, [segment])).toBe(
        `see ${atomPlainText(segment)} here`,
      );
    }
  });

  test("the editor's own copy writes the same string", () => {
    for (const segment of cases) {
      const { fallback } = serializeClipboard(`see ${TUG_ATOM_CHAR} here`, [
        { position: 4, segment },
      ], 0);
      expect(fallback).toBe(`see ${atomPlainText(segment)} here`);
    }
  });

  test("a commit is `commit:<8>` through both doors, not a link over a sha", () => {
    // The report itself: the substrate copy used to write
    // `[commit:64747b8c](<64747b8c>)` and the editor used to write the bare
    // label, for the same pill.
    const commit = atom("commit", "commit:64747b8c", SHA);
    const text = TUG_ATOM_CHAR;
    expect(formatAtomTextForCopy(text, [commit])).toBe("commit:64747b8c");
    expect(serializeClipboard(text, [{ position: 0, segment: commit }], 0).fallback).toBe(
      "commit:64747b8c",
    );
  });

  test("several atoms in one run each take their own spelling", () => {
    const text = `${TUG_ATOM_CHAR} on ${TUG_ATOM_CHAR}`;
    const atoms = [
      atom("command", "tugplug:arc", "tugplug:arc"),
      atom("file", "brief.md", ".tug/arcs/x/brief.md"),
    ];
    expect(formatAtomTextForCopy(text, atoms)).toBe(
      "/tugplug:arc on [brief.md](<.tug/arcs/x/brief.md>)",
    );
    expect(
      serializeClipboard(text, [
        { position: 0, segment: atoms[0]! },
        { position: 5, segment: atoms[1]! },
      ], 0).fallback,
    ).toBe("/tugplug:arc on [brief.md](<.tug/arcs/x/brief.md>)");
  });

  test("a stray placeholder is still passed through, not spelled", () => {
    // The [Spec S03] defensive branch: a `U+FFFC` with no atom beside it
    // survives as the character rather than being invented into a word.
    expect(formatAtomTextForCopy(`a ${TUG_ATOM_CHAR} b`, [])).toBe(`a ${TUG_ATOM_CHAR} b`);
  });
});
