/**
 * The landing face's two pure decisions: which act clears a blocker, and what
 * the disabled Join affordance says instead of being silent.
 *
 * The outcome derivation itself is proved next door in
 * `join-mode-controller.test.ts` — the component reads it, it does not own it.
 */

import { describe, expect, it } from "bun:test";

import {
  remedyRefusal,
  reportedBlockers,
  discardPreflightLine,
} from "@/components/tugways/cards/session-changes/session-changes-dash-join";
import { joinDisabledReason } from "@/lib/join-mode-controller";
import type {
  DashJoinBlockerWire,
  DashResolvedFileWire,
} from "@/lib/changeset-types";

const blocker = (
  kind: string,
  remedy?: DashJoinBlockerWire["remedy"],
): DashJoinBlockerWire => ({
  kind,
  title: "Base work in the way",
  detail: `detail for ${kind}`,
  ...(remedy !== undefined ? { remedy } : {}),
});

describe("remedyRefusal", () => {
  it("lets a remedy with no refusal be pressed", () => {
    expect(
      remedyRefusal(blocker("base-dirt", { explain: "Resolve commits it." })),
    ).toBe(null);
  });

  it("passes the server's refusal through as the reason the button is dead", () => {
    expect(
      remedyRefusal(
        blocker("base-dirt", {
          explain: "That edit belongs to ^ink-anchor.",
          refused: "Held by ^ink-anchor",
        }),
      ),
    ).toBe("Held by ^ink-anchor");
  });

  it("has nothing to press for a kind that carries no remedy at all", () => {
    // An off-base checkout, a teardown left by a crash, and any refusal this
    // deck has never heard of. Its sentence still reaches the reader — see
    // `reportedBlockers` for which surface carries it.
    expect(remedyRefusal(blocker("off-base"))).toBe(null);
    expect(remedyRefusal(blocker("some-future-refusal"))).toBe(null);
  });
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

describe("discardPreflightLine", () => {
  it("names both halves of what the confirm destroys", () => {
    expect(discardPreflightLine(2, 3)).toBe("Discards 2 rounds · 3 files");
  });

  it("uses the singular where the singular is true", () => {
    expect(discardPreflightLine(1, 1)).toBe("Discards 1 round · 1 file");
  });

  it("omits the half that is zero", () => {
    expect(discardPreflightLine(4, 0)).toBe("Discards 4 rounds");
    expect(discardPreflightLine(0, 2)).toBe("Discards 2 files");
  });

  it("does not invent a stake for a dash with no work", () => {
    expect(discardPreflightLine(0, 0)).toBe(
      "Discards nothing — this dash has no work",
    );
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
    expect(joinDisabledReason("outcome", "stale", "the dash has moved")).toBe(
      "the dash has moved",
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
