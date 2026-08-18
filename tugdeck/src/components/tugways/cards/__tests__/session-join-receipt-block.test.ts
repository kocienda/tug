/**
 * The join and discard receipts' parsers, against the exact strings the Rust
 * formatters assert. The literals are copied verbatim from
 * `format_join_summary_names_the_dash_the_base_and_the_rounds` and
 * `format_discard_summary_lists_the_round_subjects` — that copy is the point:
 * it is what keeps the two ends pinned to one format, and it fails loudly if
 * either end drifts.
 *
 * The historical discard header has no Rust formatter left to copy from, which
 * is exactly why its literal is spelled out here: it is the only remaining
 * record of a shape the app must keep reading and will never write again.
 */

import { describe, expect, it } from "bun:test";

import {
  matchesDiscardReceipt,
  matchesJoinReceipt,
  parseDiscardReceipt,
  parseJoinReceipt,
} from "@/components/tugways/cards/session-join-receipt-block";

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
    const out =
      "joined 0123456789 · join-lane → main · 5 round(s)\n" +
      "tugdash(join-lane): land the join surface";
    expect(parseJoinReceipt(out)).toEqual({
      sha: "0123456789",
      dash: "join-lane",
      base: "main",
      rounds: 5,
      message: "tugdash(join-lane): land the join surface",
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
