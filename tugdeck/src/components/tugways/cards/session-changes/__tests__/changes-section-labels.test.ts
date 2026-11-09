import { describe, expect, it } from "bun:test";

import {
  ELSEWHERE_LABEL,
  ORPHANED_LABEL,
  orphanedSectionLabel,
} from "@/components/tugways/cards/session-changes/changes-section-labels";

describe("orphanedSectionLabel", () => {
  it("names the bucket for another project only when every row is from one", () => {
    expect(orphanedSectionLabel([{ reason: "elsewhere" }, { reason: "elsewhere" }])).toBe(
      ELSEWHERE_LABEL,
    );
  });

  it("keeps the orphaned label for closed rows, mixed rows, and an older server", () => {
    expect(orphanedSectionLabel([{ reason: "closed" }])).toBe(ORPHANED_LABEL);
    expect(orphanedSectionLabel([{ reason: "elsewhere" }, { reason: "closed" }])).toBe(
      ORPHANED_LABEL,
    );
    expect(orphanedSectionLabel([{}])).toBe(ORPHANED_LABEL);
    expect(orphanedSectionLabel([])).toBe(ORPHANED_LABEL);
  });

  it("never calls the elsewhere bucket orphaned", () => {
    expect(ELSEWHERE_LABEL.name).not.toContain("orphan");
  });
});
