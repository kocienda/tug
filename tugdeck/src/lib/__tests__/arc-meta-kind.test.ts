/**
 * The recorded kind among an arc's metadata facts.
 *
 * An arc's kind — plain or planned — is written to its log when it opens, and
 * rides the wire entry as `arc_kind`. `arcMetaFacts` is the one derivation
 * every surface that names an arc reads, so what the kind *says* is settled
 * here as a pure function rather than three times over three DOMs.
 *
 * The claims:
 *
 *   - only `planned` is said, because plain is the unmarked kind — in prose
 *     and on the line alike;
 *   - an absent kind says nothing, because absence means the record does not
 *     say and never that the arc is plain;
 *   - it comes last, so the facts about what is happening now keep the lead.
 */

import { describe, test, expect } from "bun:test";

import { arcMetaFacts } from "@/lib/arc-meta-facts";
import type { ArcChangesetEntry } from "@/lib/changeset-types";

function entry(arc_kind?: ArcChangesetEntry["arc_kind"]): ArcChangesetEntry {
  return {
    kind: "arc",
    owner_id: "tugarc/foo#1",
    display_name: "foo",
    base: "main",
    rounds: 3,
    worktree: "/tmp/foo",
    worktree_dirty: false,
    files: [],
    ...(arc_kind !== undefined ? { arc_kind } : {}),
  };
}

const keys = (e: ArcChangesetEntry): string[] => arcMetaFacts(e).map((f) => f.key);

describe("the recorded kind on the arc metadata line", () => {
  const table: ReadonlyArray<{
    name: string;
    arc_kind: ArcChangesetEntry["arc_kind"];
    said: boolean;
  }> = [
    { name: "a planned arc says so", arc_kind: "planned", said: true },
    { name: "a plain arc says nothing — plain is unmarked", arc_kind: "plain", said: false },
    { name: "a pre-kind arc says nothing — absence is not plain", arc_kind: undefined, said: false },
  ];

  for (const row of table) {
    test(row.name, () => {
      expect(keys(entry(row.arc_kind)).includes("kind")).toBe(row.said);
    });
  }

  test("it reads `planned`, quietly, and says what the word means", () => {
    const fact = arcMetaFacts(entry("planned")).find((f) => f.key === "kind");
    expect(fact?.label).toBe("planned");
    expect(fact?.tone).toBe("muted");
    expect(fact?.tooltip).toContain("reviewed cold");
  });

  test("it comes last, so the facts about the arc's present state lead", () => {
    // A dirty worktree and a base that has moved are both louder than a
    // standing property of the arc, and both are ordinary mid-run.
    const e: ArcChangesetEntry = {
      ...entry("planned"),
      worktree_dirty: true,
      base_ahead: 2,
      arc: { stage: "implement" },
    };
    const order = keys(e);
    expect(order).toContain("kind");
    expect(order[order.length - 1]).toBe("kind");
    expect(order.indexOf("kind")).toBeGreaterThan(order.indexOf("uncommitted"));
    expect(order.indexOf("kind")).toBeGreaterThan(order.indexOf("arc"));
  });
});
