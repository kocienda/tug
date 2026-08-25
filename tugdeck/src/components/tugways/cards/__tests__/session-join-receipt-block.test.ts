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

/**
 * The four shapes the parser's cursor has to survive, one case each.
 *
 * The second is the regression a positional parser would have introduced: with
 * `fit:` inserted above `files:`, a parser testing `lines[1]` for the files
 * prefix silently orphans the file list of every join receipt already in
 * JSONL — and a transcript replays from its record on every card reload, so
 * "already written" means forever. Every literal below is copied verbatim from
 * `format_join_summary_is_parse_stable_across_every_optional_line`.
 */
describe("the join receipt's optional lines, in every combination", () => {
  const FILES_LINE =
    'files: [{"path":"src/a.rs","status":"modified","added":1,"removed":0}]';
  const FIT_LINE = "fit: verified 3f0a1c9e2b onto 91c4de70f2";
  const HEADER = "joined abc1234567 · d → trunk · 1 round(s)";

  it("header + fit + files + message", () => {
    const parsed = parseJoinReceipt(`${HEADER}\n${FIT_LINE}\n${FILES_LINE}\nSubject`);
    expect(parsed?.message).toBe("Subject");
    expect(parsed?.files.map((f) => f.path)).toEqual(["src/a.rs"]);
    expect(parsed?.fit).toEqual({ verified: true, head: "3f0a1c9e2b", base: "91c4de70f2" });
  });

  it("header + files + message — the pre-fit shape, files still at index 1", () => {
    const parsed = parseJoinReceipt(`${HEADER}\n${FILES_LINE}\nSubject`);
    expect(parsed?.message).toBe("Subject");
    expect(parsed?.files.map((f) => f.path)).toEqual(["src/a.rs"]);
    expect(parsed?.fit).toBeUndefined();
  });

  it("header + fit + message", () => {
    const parsed = parseJoinReceipt(`${HEADER}\n${FIT_LINE}\nSubject`);
    expect(parsed?.message).toBe("Subject");
    expect(parsed?.files).toEqual([]);
    expect(parsed?.fit?.verified).toBe(true);
  });

  it("header + message alone", () => {
    const parsed = parseJoinReceipt(`${HEADER}\nSubject`);
    expect(parsed?.message).toBe("Subject");
    expect(parsed?.files).toEqual([]);
    expect(parsed?.fit).toBeUndefined();
  });

  it("a stale fit parses as one, and a multi-line message survives either way", () => {
    const parsed = parseJoinReceipt(
      `${HEADER}\nfit: stale 3f0a1c9e2b onto 91c4de70f2\n${FILES_LINE}\nSubject\n\nBody paragraph.`,
    );
    expect(parsed?.fit).toEqual({ verified: false, head: "3f0a1c9e2b", base: "91c4de70f2" });
    expect(parsed?.message).toBe("Subject\n\nBody paragraph.");
  });

  it("a line that is neither prefix belongs to the message, not to a parse miss", () => {
    const parsed = parseJoinReceipt(`${HEADER}\nfit: something else entirely\nSubject`);
    expect(parsed).not.toBe(null);
    expect(parsed?.fit).toBeUndefined();
    expect(parsed?.message).toBe("fit: something else entirely\nSubject");
  });
});
