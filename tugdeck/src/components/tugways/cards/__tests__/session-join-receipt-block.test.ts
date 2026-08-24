/**
 * The join and discard receipts' parsers, against the exact strings the Rust
 * formatters assert. The literals are copied verbatim from
 * `format_join_summary_carries_the_files_line` and
 * `format_discard_summary_lists_the_round_subjects` — that copy is the point:
 * it is what keeps the two ends pinned to one format, and it fails loudly if
 * either end drifts.
 *
 * Two literals here have no Rust formatter left to copy from, and that is
 * exactly why they are spelled out: the historical discard header, and a join
 * receipt written before the `files:` line existed. Both are shapes the app
 * must keep reading and will never write again.
 */

import { describe, expect, it } from "bun:test";

import {
  matchesDiscardReceipt,
  matchesJoinReceipt,
  parseDiscardReceipt,
  parseJoinReceipt,
} from "@/components/tugways/cards/session-join-receipt-block";
// Side-effect import: the commit receipt registers itself too, so the shipped
// population below is the real one the transcript resolves against.
import "@/components/tugways/cards/session-commit-receipt-block";
import { resolveCommandAttribution } from "@/components/tugways/cards/session-command-block-registry";

describe("what the shipped receipts are attributed to", () => {
  it("attributes both landings to git and the discard to the shell", () => {
    // The 2026-08-24 report: a dash join rendered its commit block under a
    // `Shell` header while `/commit` rendered the same kind of block under a
    // git one. A join squashes its rounds and commits them onto the base — the
    // same act, differently started — so it reads the same way.
    expect(resolveCommandAttribution("/commit")).toBe("git");
    expect(resolveCommandAttribution("/dash-join")).toBe("git");
    expect(resolveCommandAttribution("/dash-join lifecycle-fixup")).toBe("git");
    // A discard deletes a branch and commits nothing, so it is not a landing
    // and keeps the shell default.
    expect(resolveCommandAttribution("/dash-discard")).toBe("shell");
    expect(resolveCommandAttribution("/dash-release")).toBe("shell");
    // And an ordinary typed command is what the default is for.
    expect(resolveCommandAttribution("git status")).toBe("shell");
  });
});

describe("matchesJoinReceipt / matchesDiscardReceipt", () => {
  it("claims the two verbs and nothing that merely starts like them", () => {
    expect(matchesJoinReceipt("/dash-join")).toBe(true);
    expect(matchesJoinReceipt("/dash-join spike")).toBe(true);
    expect(matchesJoinReceipt("/dash-joins")).toBe(false);
    expect(matchesJoinReceipt("/join")).toBe(false);
    expect(matchesDiscardReceipt("/dash-discard")).toBe(true);
    expect(matchesDiscardReceipt("/dash-discard spike")).toBe(true);
    expect(matchesDiscardReceipt("/dash-discards")).toBe(false);
  });

  it("still claims the command name the verb wrote before it was renamed", () => {
    // These rows are in session JSONL and replay on every card reload. Drop
    // them and every discard already recorded reverts to a raw shell row.
    expect(matchesDiscardReceipt("/dash-release")).toBe(true);
    expect(matchesDiscardReceipt("/dash-release spike")).toBe(true);
    expect(matchesDiscardReceipt("/dash-released")).toBe(false);
  });
});

describe("parseJoinReceipt", () => {
  it("round-trips the exact S01 summary the server writes", () => {
    // Copied verbatim from `format_join_summary_carries_the_files_line`.
    const out =
      "joined 0123456789 · join-lane → main · 5 round(s)\n" +
      'files: [{"path":"src/a.rs","status":"modified","added":16,"removed":1},' +
      '{"path":"src/b.rs","status":"created","added":4,"removed":0}]\n' +
      "tugdash(join-lane): land the join surface";
    expect(parseJoinReceipt(out)).toEqual({
      sha: "0123456789",
      dash: "join-lane",
      base: "main",
      rounds: 5,
      message: "tugdash(join-lane): land the join surface",
      files: [
        { path: "src/a.rs", status: "modified", added: 16, removed: 1 },
        { path: "src/b.rs", status: "created", added: 4, removed: 0 },
      ],
    });
  });

  it("still parses a receipt written before the files line existed", () => {
    // The parse-forever pin. Transcripts replay from JSONL on every card
    // reload, so every join receipt already recorded arrives here forever;
    // this literal is read and never written. A non-squash join reaches the
    // same path, because the server omits the line rather than writing a
    // partial list.
    const out =
      "joined 0123456789 · join-lane → main · 5 round(s)\n" +
      "tugdash(join-lane): land the join surface";
    expect(parseJoinReceipt(out)).toEqual({
      sha: "0123456789",
      dash: "join-lane",
      base: "main",
      rounds: 5,
      message: "tugdash(join-lane): land the join surface",
      files: [],
    });
  });

  it("keeps a multi-line message whole", () => {
    const out =
      "joined abcdef0123 · d → trunk · 1 round(s)\n" +
      "Subject line\n\nA longer body paragraph.";
    expect(parseJoinReceipt(out)?.message).toBe(
      "Subject line\n\nA longer body paragraph.",
    );
  });

  it("does not mistake a message whose first line merely mentions files", () => {
    // The prefix test is exact: only a line that STARTS `files: ` is the file
    // list, so a squash message opening with the word survives as message.
    const out =
      "joined abcdef0123 · d → trunk · 1 round(s)\n" +
      "the files: they moved";
    const parsed = parseJoinReceipt(out);
    expect(parsed?.files).toEqual([]);
    expect(parsed?.message).toBe("the files: they moved");
  });

  it("returns null for a legacy or truncated row", () => {
    expect(parseJoinReceipt("")).toBe(null);
    expect(parseJoinReceipt("joined join-lane into main")).toBe(null);
    // A hand-typed hyphen where the U+2192 arrow belongs is not a receipt.
    expect(parseJoinReceipt("joined 0123456789 · d -> main · 1 round(s)\nm")).toBe(null);
  });
});

describe("parseDiscardReceipt", () => {
  it("round-trips the exact S02 summary, files and subjects included", () => {
    const out =
      "discarded spike · 2 round(s), 3 file(s)\n" +
      "first round\nsecond round";
    expect(parseDiscardReceipt(out)).toEqual({
      dash: "spike",
      rounds: 2,
      files: 3,
      subjects: ["first round", "second round"],
    });
  });

  it("reads a clean dash's one-line summary", () => {
    expect(parseDiscardReceipt("discarded spike · 0 round(s)")).toEqual({
      dash: "spike",
      rounds: 0,
      files: 0,
      subjects: [],
    });
  });

  it("reads the header the verb wrote before it was renamed", () => {
    // `released <dash> · discarded <N>` — the shape that led with one verb and
    // repeated the act with another. Nothing writes it now; a transcript full
    // of it still replays on every reload, so both forms must yield the same
    // facts or a real discard renders as an unparsed shell row.
    const historical =
      "released spike · discarded 2 round(s), 3 file(s)\n" +
      "first round\nsecond round";
    expect(parseDiscardReceipt(historical)).toEqual({
      dash: "spike",
      rounds: 2,
      files: 3,
      subjects: ["first round", "second round"],
    });
    expect(parseDiscardReceipt("released spike · discarded 0 round(s)")).toEqual({
      dash: "spike",
      rounds: 0,
      files: 0,
      subjects: [],
    });
  });

  it("returns null for a row that is not an S02 summary", () => {
    expect(parseDiscardReceipt("released spike")).toBe(null);
    expect(parseDiscardReceipt("discarded spike")).toBe(null);
    // The historical head without its second verb is neither shape.
    expect(parseDiscardReceipt("released spike · 2 round(s)")).toBe(null);
  });
});
