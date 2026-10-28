/**
 * The landing face's pure decisions: which blockers the report speaks about,
 * what the disabled Join affordance says instead of being silent, and the
 * fit sentence the report opens on.
 *
 * The outcome derivation itself is proved next door in
 * `join-mode-controller.test.ts` — the component reads it, it does not own it.
 */

import { describe, expect, it } from "bun:test";

import {
  reportedBlockers,
  deriveResolveFace,
} from "@/components/tugways/cards/session-changes/session-changes-arc-join";
import { joinDisabledReason } from "@/lib/join-mode-controller";
import { arcFitSentence } from "@/lib/arc-fit";
import type {
  ArcJoinBlockerWire,
} from "@/lib/changeset-types";

const blocker = (
  kind: string,
  remedy?: ArcJoinBlockerWire["remedy"],
): ArcJoinBlockerWire => ({
  kind,
  title: "Base work in the way",
  detail: `detail for ${kind}`,
  ...(remedy !== undefined ? { remedy } : {}),
});

describe("reportedBlockers", () => {
  const remedy = { explain: "Resolve commits that work onto the base." };

  it("keeps the first blocker for the remedy the register cannot show", () => {
    const only = blocker("base-dirt", remedy);
    expect(reportedBlockers([only])).toEqual([{ blocker: only, index: 0 }]);
  });

  it("drops a first blocker the register has already said in full", () => {
    expect(reportedBlockers([blocker("off-base")])).toEqual([]);
  });

  it("always speaks for a blocker past the first, which has no other voice", () => {
    const first = blocker("base-dirt", remedy);
    const second = blocker("off-base");
    expect(reportedBlockers([first, second])).toEqual([
      { blocker: first, index: 0 },
      { blocker: second, index: 1 },
    ]);
  });

  it("keeps the index the server sent, so a dropped first does not renumber", () => {
    const second = blocker("base-dirt", remedy);
    expect(reportedBlockers([blocker("off-base"), second])).toEqual([
      { blocker: second, index: 1 },
    ]);
  });

  it("has nothing to report for a join nothing blocks", () => {
    expect(reportedBlockers([])).toEqual([]);
  });
});

describe("joinDisabledReason", () => {
  it("answers with the gate's own reason before it looks at the outcome", () => {
    expect(joinDisabledReason("turn", "clean")).toBe(
      "Wait for the turn to finish",
    );
    expect(joinDisabledReason("pending", "clean")).toBe("Joining…");
  });

  it("names what the outcome is waiting on", () => {
    expect(joinDisabledReason("outcome", "stale", "the arc has moved")).toBe(
      "the arc has moved",
    );
    expect(joinDisabledReason("outcome", "conflicted")).toBe(
      "Resolve the conflicts first",
    );
    expect(joinDisabledReason("outcome", "blocked")).toBe(
      "Clear what blocks this join first",
    );
    expect(joinDisabledReason("outcome", "empty")).toBe("Nothing to join");
  });
});

describe("deriveResolveFace", () => {
  it("gives the fold its own face, from the feed and from the press alike", () => {
    // The two acts share the resolving phase, so a face read off the phase
    // alone would dress a fold as the ladder and narrate rungs it has none of.
    expect(deriveResolveFace("blocked", "resolving", null, "resolve-base")).toBe(
      "folding",
    );
    // And the client's own act stands in for the window before the recompute
    // that puts the hold on the entry.
    expect(
      deriveResolveFace("blocked", "resolving", null, null, "resolve-base"),
    ).toBe("folding");
  });

  it("leaves the ladder's face alone", () => {
    expect(deriveResolveFace("conflicted", "resolving", null, null)).toBe(
      "progress",
    );
    expect(deriveResolveFace("conflicted", "idle", null, "resolve")).toBe(
      "progress",
    );
  });

  it("keeps the candidate above the running phase", () => {
    // What makes a resolution survive a reload: the phase is a client overlay
    // that dies with the page, the candidate is a ref the server re-reports.
    expect(deriveResolveFace("conflicted", "idle", "cafe1234", null)).toBe(
      "resolved",
    );
  });
});

describe("arcFitSentence", () => {
  const HEAD = "3f0a1c9e2b7d4f6a";
  const BASE = "91c4de70f2a3b5c7";

  it("says never verified when no verify has passed", () => {
    expect(arcFitSentence(undefined)).toEqual({
      reading: "never",
      text: "Not verified — no verify has passed on this arc.",
    });
  });

  it("names the pair and says it stands when both endpoints are current", () => {
    expect(
      arcFitSentence({ head: HEAD, base: BASE, current: true }),
    ).toEqual({
      reading: "current",
      text: "Verified at 3f0a1c9 onto 91c4de7, and both still stand.",
    });
  });

  it("names which endpoint moved when the verify is stale", () => {
    const stale = { head: HEAD, base: BASE, current: false };
    expect(arcFitSentence({ ...stale, head_moved: true }).text).toBe(
      "Verified at 3f0a1c9 onto 91c4de7, but the arc has moved since.",
    );
    expect(arcFitSentence({ ...stale, base_moved: true }).text).toBe(
      "Verified at 3f0a1c9 onto 91c4de7, but the base has moved since.",
    );
    expect(
      arcFitSentence({ ...stale, head_moved: true, base_moved: true }).text,
    ).toBe(
      "Verified at 3f0a1c9 onto 91c4de7, but the arc and the base have both moved since.",
    );
    expect(arcFitSentence({ ...stale, head_moved: true }).reading).toBe(
      "stale",
    );
  });

  it("still reads stale when the server names no endpoint", () => {
    expect(
      arcFitSentence({ head: HEAD, base: BASE, current: false }),
    ).toEqual({
      reading: "stale",
      text: "Verified at 3f0a1c9 onto 91c4de7, but that pair no longer stands.",
    });
  });
});
