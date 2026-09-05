/**
 * The join boundary's find projection is gated on its fold.
 *
 * The transcript's find has one invariant: **a counted match is a paintable
 * match.** The index projects each row as an ordered list of units, the
 * painter walks the row's `data-tugx-findable` containers, and the two pair
 * POSITIONALLY — so a part projected while its container is unmounted is a
 * match the chip counts and the painter can never reach. That is the "1 of 18
 * over a transcript that never moves" defect the declare-both-halves rule in
 * `session-command-block-registry.ts` exists to prevent.
 *
 * Folding the join's receipt behind its boundary put that invariant at risk
 * for the first time on a bespoke block: three of the four things the join
 * used to project — the `arc → base` line, the fit note and the message body —
 * are now unmounted while the bar is collapsed. `joinReceiptFindParts` is
 * therefore handed the fold state, and this file pins what it answers in each.
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

describe("joinReceiptFindParts — gated on the boundary's fold", () => {
  test("collapsed, it projects only what the bar shows", () => {
    const parts = joinReceiptFindParts(exchange(JOIN_OUTPUT), true);
    expect(parts).toEqual([
      "Joined join-lane into main",
      "tugarc(join-lane): land the join surface",
    ]);
  });

  test("collapsed, nothing from the folded receipt is counted", () => {
    const parts = joinReceiptFindParts(exchange(JOIN_OUTPUT), true) ?? [];
    const joined = parts.join(" ");
    // The three unmounted regions, each named by a string only it carries.
    expect(joined).not.toContain("join-lane → main");
    expect(joined).not.toContain("fit verified");
    expect(joined).not.toContain("occupancy guard");
  });

  test("expanded, the receipt's own regions project in render order", () => {
    const parts = joinReceiptFindParts(exchange(JOIN_OUTPUT), false) ?? [];
    expect(parts[0]).toBe("Joined join-lane into main");
    expect(parts[1]).toBe("tugarc(join-lane): land the join surface");
    expect(parts[2]).toBe("join-lane → main");
    expect(parts[3]).toBe("fit verified 3f0a91c2 onto e7d5b0a4");
    expect(parts.join(" ")).toContain("occupancy guard");
  });

  test("the event projects in both states, so a branch name always finds the row", () => {
    for (const collapsed of [true, false]) {
      const parts = joinReceiptFindParts(exchange(JOIN_OUTPUT), collapsed) ?? [];
      expect(parts[0]).toBe("Joined join-lane into main");
    }
  });

  test("a receipt with no subject still leads with its event", () => {
    // The degraded shape: no squash subject, so the headline falls back to
    // `arc → base` and the identity line is not rendered at all.
    const bare = ["joined fedcba9876 · old-lane → main · 2 round(s)"].join("\n");
    expect(joinReceiptFindParts(exchange(bare), true)).toEqual([
      "Joined old-lane into main",
      "old-lane → main",
    ]);
    expect(joinReceiptFindParts(exchange(bare), false)).toEqual([
      "Joined old-lane into main",
      "old-lane → main",
      // An empty message body; the registry drops empty parts before the
      // index sees them, so this never becomes a unit.
      "",
    ]);
  });

  test("output the parser does not claim projects nothing at all", () => {
    // `null` sends the row to the generic shell block, which projects itself.
    expect(joinReceiptFindParts(exchange("joined join-lane into main"), true)).toBeNull();
    expect(joinReceiptFindParts(exchange("joined join-lane into main"), false)).toBeNull();
  });
});
