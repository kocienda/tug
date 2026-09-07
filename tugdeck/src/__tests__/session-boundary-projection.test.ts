/**
 * The landing row's find projection, and what its boundary's fold gates.
 *
 * The transcript's find has one invariant: **a counted match is a paintable
 * match.** The index projects each row as an ordered list of units, the
 * painter walks the row's `data-tugx-findable` containers, and the two pair
 * POSITIONALLY — so a part projected while its container is unmounted is a
 * match the chip counts and the painter can never reach. That is the "1 of 18
 * over a transcript that never moves" defect the declare-both-halves rule in
 * `session-command-block-registry.ts` exists to prevent.
 *
 * A landing is now two things in document order: the commit receipt in the
 * `Git Commit` entry's body column, then the `Joined` boundary at the
 * transcript's edge ([B01], [B02]). The receipt's regions are mounted either
 * way — its own fold is a separate key the index does not resolve, exactly as
 * `/commit`'s is — and the one thing behind the boundary's fold is the arc's
 * record. So the `collapsed` flag `joinReceiptFindParts` is handed is the
 * BOUNDARY's, and the record is what it gates.
 *
 * `at0494` pins the paint parity itself, in the real app, over the opened
 * boundary. This is the half that is a function over data.
 */

import { describe, expect, test } from "bun:test";

import { joinReceiptFindParts } from "@/components/tugways/cards/session-join-receipt-block";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";

/** The bytes `format_join_summary` writes for a squash landing. */
const JOIN_OUTPUT = [
  "joined 0123456789 · join-lane → main · 5 round(s)",
  "fit: verified 3f0a91c2 onto e7d5b0a4",
  'files: [{"path":"src/a.rs","status":"modified","added":16,"removed":1}]',
  "tugarc(join-lane): land the join surface",
  "",
  "The reconcile runs once per base, under the occupancy guard.",
].join("\n");

/**
 * The same landing with the arc's record on it — the `arc: ` run seated
 * between `fit:` and `files:`, copied from
 * `format_join_summary_carries_the_arc_record_between_the_fit_and_the_files`.
 */
const JOIN_OUTPUT_WITH_RECORD = [
  "joined 0123456789 · join-lane → main · 5 round(s)",
  "fit: verified 3f0a91c2 onto e7d5b0a4",
  "arc: opened on .tug/arcs/join-lane/brief.md",
  "arc: devise · opus · sess-devise",
  "arc: implement · account default · sess-implement",
  "arc: plan .tug/arcs/join-lane/plan.md",
  'files: [{"path":"src/a.rs","status":"modified","added":16,"removed":1}]',
  "tugarc(join-lane): land the join surface",
  "",
  "The reconcile runs once per base, under the occupancy guard.",
].join("\n");

function exchange(output: string): ShellExchangeMessage {
  return {
    kind: "shell_exchange",
    messageKey: "m1",
    createdAt: 0,
    exchangeId: "x1",
    command: "/arc-join join-lane",
    output,
    exitCode: 0,
    cwd: "/tmp",
    cwdAfter: "/tmp",
    startedAtMs: 0,
    settledAtMs: 0,
  };
}

describe("joinReceiptFindParts — the receipt, then the boundary", () => {
  test("the receipt's regions project in render order, ahead of the event", () => {
    // Render order is the entry's body column first: the header's subject,
    // then the `arc → base` line, its fit, and the message body. The
    // boundary's event follows, because the boundary follows the entry.
    const parts = joinReceiptFindParts(exchange(JOIN_OUTPUT), true) ?? [];
    expect(parts[0]).toBe("tugarc(join-lane): land the join surface");
    expect(parts[1]).toBe("join-lane → main");
    expect(parts[2]).toBe("fit verified 3f0a91c2 onto e7d5b0a4");
    expect(parts.join(" ")).toContain("occupancy guard");
    expect(parts[parts.length - 1]).toBe("Joined join-lane into main");
  });

  test("the receipt's regions are ungated — they are not behind the boundary", () => {
    // They moved out of the fold and into the `Git Commit` entry ([B01]), so
    // the boundary's collapse state says nothing about them and both readings
    // are the same list.
    expect(joinReceiptFindParts(exchange(JOIN_OUTPUT), true)).toEqual(
      joinReceiptFindParts(exchange(JOIN_OUTPUT), false),
    );
  });

  test("the event projects in both states, so a branch name always finds the row", () => {
    for (const collapsed of [true, false]) {
      const parts = joinReceiptFindParts(exchange(JOIN_OUTPUT), collapsed) ?? [];
      expect(parts).toContain("Joined join-lane into main");
    }
  });

  test("collapsed, nothing from the boundary's fold is counted", () => {
    const parts = joinReceiptFindParts(exchange(JOIN_OUTPUT_WITH_RECORD), true) ?? [];
    const joined = parts.join(" ");
    // The record is the whole of what the fold holds, and it is unmounted.
    expect(joined).not.toContain("opened on");
    expect(joined).not.toContain("plan .tug/arcs");
    // The receipt above it is not, and still reads.
    expect(joined).toContain("occupancy guard");
  });

  test("expanded, the record projects last, in the order the fold renders it", () => {
    const parts = joinReceiptFindParts(exchange(JOIN_OUTPUT_WITH_RECORD), false) ?? [];
    expect(parts.slice(-3)).toEqual([
      "Joined join-lane into main",
      "opened on .tug/arcs/join-lane/brief.md",
      "plan .tug/arcs/join-lane/plan.md",
    ]);
  });

  test("the stage rows are never projected, in either state", () => {
    // A stage row's third cell is resolved asynchronously from the session
    // ledger and is empty until it answers, so a unit carrying it would be a
    // match the painter reaches only sometimes — the landed-files list's own
    // terms.
    for (const collapsed of [true, false]) {
      const joined = (
        joinReceiptFindParts(exchange(JOIN_OUTPUT_WITH_RECORD), collapsed) ?? []
      ).join(" ");
      expect(joined).not.toContain("sess-devise");
      expect(joined).not.toContain("account default");
    }
  });

  test("a receipt with no record has nothing behind its fold to gate", () => {
    // Every join written before the `arc: ` lines existed, and every one whose
    // arc log had nothing to say — one absence, one code path.
    expect(joinReceiptFindParts(exchange(JOIN_OUTPUT), true)).toEqual(
      joinReceiptFindParts(exchange(JOIN_OUTPUT), false),
    );
  });

  test("a receipt with no subject still projects its event", () => {
    // The degraded shape: no squash subject, so the headline falls back to
    // `arc → base` and the identity line is not rendered at all.
    const bare = ["joined fedcba9876 · old-lane → main · 2 round(s)"].join("\n");
    expect(joinReceiptFindParts(exchange(bare), true)).toEqual([
      "old-lane → main",
      // An empty message body; the registry drops empty parts before the
      // index sees them, so this never becomes a unit.
      "",
      "Joined old-lane into main",
    ]);
  });

  test("output the parser does not claim projects nothing at all", () => {
    // `null` sends the row to the generic shell block, which projects itself.
    expect(joinReceiptFindParts(exchange("joined join-lane into main"), true)).toBeNull();
    expect(joinReceiptFindParts(exchange("joined join-lane into main"), false)).toBeNull();
  });
});

